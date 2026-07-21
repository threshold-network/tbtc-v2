/* eslint-disable no-await-in-loop, no-restricted-syntax, no-plusplus */
import { BigNumber, ethers, providers } from "ethers"

// `merkle-patricia-tree` is already part of the Hardhat dependency graph. It
// is intentionally used here instead of trusting an RPC's receipt/transaction
// arrays: recomputing both trie roots is what turns complete enumeration into a
// proof against the canonical block header.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const Trie = require("merkle-patricia-tree")

const EMPTY_TRIE_ROOT =
  "0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421"
const HISTORY_DOMAIN = ethers.utils.keccak256(
  ethers.utils.toUtf8Bytes("tbtc/ecdsa-fraud-cutover/canonical-history/v1")
)
const BLOCK_DOMAIN = ethers.utils.keccak256(
  ethers.utils.toUtf8Bytes("tbtc/ecdsa-fraud-cutover/canonical-block/v1")
)
const RECEIPT_DOMAIN = ethers.utils.keccak256(
  ethers.utils.toUtf8Bytes("tbtc/ecdsa-fraud-cutover/canonical-receipt/v1")
)
const LOG_DOMAIN = ethers.utils.keccak256(
  ethers.utils.toUtf8Bytes("tbtc/ecdsa-fraud-cutover/canonical-log/v1")
)

type RpcRecord = Record<string, unknown>

export type CanonicalHistoryEvidence = {
  chainId: number
  bridge: string
  emitterSetCommitment: string
  scanStartBlock: number
  finalizedBlock: number
  startParentHash: string
  startBlockHash: string
  finalizedBlockHash: string
  historyCommitment: string
  blockCount: number
  transactionCount: number
  receiptCount: number
  logCount: number
  emitterLogCount: number
  emitterLogDigest: string
  candidateCallCount: number
  candidateCallDigest: string
}

export type CanonicalHistoryEmitter = {
  address: string
  runtimeCodeHash: string
}

export type CanonicalHistoryScan = {
  evidence: CanonicalHistoryEvidence
  emitters: CanonicalHistoryEmitter[]
  emitterLogs: providers.Log[]
  selectedLogs: providers.Log[]
  candidateCalls: CanonicalCandidateCall[]
  selectedTransactions: Record<
    string,
    { from: string; to: string | null; data: string; value: string }
  >
}

export type CanonicalCandidateCall = {
  transactionHash: string
  from: string
  to: string
  input: string
  value: string
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    if (typeof value === "number" && !Number.isSafeInteger(value)) {
      throw new Error("canonical history contains an unsafe number")
    }
    const encoded = JSON.stringify(value)
    if (encoded === undefined) {
      throw new Error("canonical history contains an unsupported value")
    }
    return encoded
  }
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(",")}]`
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
  return `{${entries
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`)
    .join(",")}}`
}

/// @notice Exact, deterministic digest of the durable checkpoint payload.
///         Array order remains significant while object key order does not.
export function canonicalHistoryCheckpointCommitment(
  scan: CanonicalHistoryScan
): string {
  return ethers.utils.keccak256(ethers.utils.toUtf8Bytes(canonicalJson(scan)))
}

const EMITTER_SET_DOMAIN = ethers.utils.keccak256(
  ethers.utils.toUtf8Bytes("tbtc/ecdsa-fraud-cutover/emitter-set/v1")
)
const CANDIDATE_CALL_DOMAIN = ethers.utils.keccak256(
  ethers.utils.toUtf8Bytes("tbtc/ecdsa-fraud-cutover/candidate-call/v1")
)

type JsonRpcProvider = providers.Provider & {
  send(method: string, params: unknown[]): Promise<unknown>
}

function asRecord(value: unknown, label: string): RpcRecord {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${label} is missing or malformed`)
  }
  return value as RpcRecord
}

function asArray(value: unknown, label: string): unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} is not an array`)
  return value
}

function asString(value: unknown, label: string): string {
  if (typeof value !== "string") throw new Error(`${label} is not a string`)
  return value
}

function normalizedHex(value: unknown, label: string): string {
  const encoded = asString(value, label)
  if (!ethers.utils.isHexString(encoded)) {
    throw new Error(`${label} is not hex data`)
  }
  return ethers.utils.hexlify(encoded).toLowerCase()
}

function fixedHex(value: unknown, length: number, label: string): string {
  const encoded = normalizedHex(value, label)
  if (ethers.utils.hexDataLength(encoded) !== length) {
    throw new Error(`${label} must be ${length} bytes`)
  }
  return encoded
}

function quantity(value: unknown, label: string): BigNumber {
  try {
    return BigNumber.from(value)
  } catch (_) {
    throw new Error(`${label} is not a canonical quantity`)
  }
}

function rlpQuantity(value: unknown, label: string): string {
  const number = quantity(value, label)
  if (number.isZero()) return "0x"
  return ethers.utils.hexStripZeros(number.toHexString())
}

function numberQuantity(value: unknown, label: string): number {
  const result = quantity(value, label).toNumber()
  if (!Number.isSafeInteger(result) || result < 0) {
    throw new Error(`${label} exceeds the safe integer range`)
  }
  return result
}

function optionalQuantity(
  record: RpcRecord,
  field: string,
  output: Array<string | unknown[]>
): void {
  if (record[field] !== undefined && record[field] !== null) {
    output.push(rlpQuantity(record[field], field))
  }
}

function encodeAccessList(value: unknown, label: string): unknown[] {
  return asArray(value ?? [], label).map((entry, index) => {
    if (Array.isArray(entry)) {
      if (entry.length !== 2) {
        throw new Error(`${label}[${index}] must have two elements`)
      }
      return [
        fixedHex(entry[0], 20, `${label}[${index}].address`),
        asArray(entry[1], `${label}[${index}].storageKeys`).map(
          (key, keyIndex) =>
            fixedHex(key, 32, `${label}[${index}].storageKeys[${keyIndex}]`)
        ),
      ]
    }
    const item = asRecord(entry, `${label}[${index}]`)
    return [
      fixedHex(item.address, 20, `${label}[${index}].address`),
      asArray(item.storageKeys, `${label}[${index}].storageKeys`).map(
        (key, keyIndex) =>
          fixedHex(key, 32, `${label}[${index}].storageKeys[${keyIndex}]`)
      ),
    ]
  })
}

function encodeAuthorizationList(value: unknown): unknown[] {
  return asArray(value ?? [], "authorizationList").map((entry, index) => {
    const item = asRecord(entry, `authorizationList[${index}]`)
    return [
      rlpQuantity(item.chainId, `authorizationList[${index}].chainId`),
      fixedHex(item.address, 20, `authorizationList[${index}].address`),
      rlpQuantity(item.nonce, `authorizationList[${index}].nonce`),
      rlpQuantity(
        item.yParity ?? item.v,
        `authorizationList[${index}].yParity`
      ),
      rlpQuantity(item.r, `authorizationList[${index}].r`),
      rlpQuantity(item.s, `authorizationList[${index}].s`),
    ]
  })
}

function transactionTo(value: unknown): string {
  if (value === null || value === undefined) return "0x"
  return fixedHex(value, 20, "transaction.to")
}

function typedTransactionPrefix(type: number): string {
  if (type <= 0 || type > 0x7f) {
    throw new Error(`unsupported typed transaction ${type}`)
  }
  return ethers.utils.hexZeroPad(ethers.utils.hexlify(type), 1)
}

export function serializeRpcTransaction(transactionValue: unknown): string {
  const transaction = asRecord(transactionValue, "transaction")
  const type = numberQuantity(transaction.type ?? 0, "transaction.type")
  const input = normalizedHex(
    transaction.input ?? transaction.data ?? "0x",
    "transaction.input"
  )
  const yParity = transaction.yParity ?? transaction.v
  let payload: unknown[]

  if (type === 0) {
    payload = [
      rlpQuantity(transaction.nonce, "transaction.nonce"),
      rlpQuantity(transaction.gasPrice, "transaction.gasPrice"),
      rlpQuantity(transaction.gas, "transaction.gas"),
      transactionTo(transaction.to),
      rlpQuantity(transaction.value, "transaction.value"),
      input,
      rlpQuantity(transaction.v, "transaction.v"),
      rlpQuantity(transaction.r, "transaction.r"),
      rlpQuantity(transaction.s, "transaction.s"),
    ]
    return ethers.utils.RLP.encode(payload)
  }

  if (type === 1) {
    payload = [
      rlpQuantity(transaction.chainId, "transaction.chainId"),
      rlpQuantity(transaction.nonce, "transaction.nonce"),
      rlpQuantity(transaction.gasPrice, "transaction.gasPrice"),
      rlpQuantity(transaction.gas, "transaction.gas"),
      transactionTo(transaction.to),
      rlpQuantity(transaction.value, "transaction.value"),
      input,
      encodeAccessList(transaction.accessList, "transaction.accessList"),
      rlpQuantity(yParity, "transaction.yParity"),
      rlpQuantity(transaction.r, "transaction.r"),
      rlpQuantity(transaction.s, "transaction.s"),
    ]
  } else if (type === 2) {
    payload = [
      rlpQuantity(transaction.chainId, "transaction.chainId"),
      rlpQuantity(transaction.nonce, "transaction.nonce"),
      rlpQuantity(
        transaction.maxPriorityFeePerGas,
        "transaction.maxPriorityFeePerGas"
      ),
      rlpQuantity(transaction.maxFeePerGas, "transaction.maxFeePerGas"),
      rlpQuantity(transaction.gas, "transaction.gas"),
      transactionTo(transaction.to),
      rlpQuantity(transaction.value, "transaction.value"),
      input,
      encodeAccessList(transaction.accessList, "transaction.accessList"),
      rlpQuantity(yParity, "transaction.yParity"),
      rlpQuantity(transaction.r, "transaction.r"),
      rlpQuantity(transaction.s, "transaction.s"),
    ]
  } else if (type === 3) {
    payload = [
      rlpQuantity(transaction.chainId, "transaction.chainId"),
      rlpQuantity(transaction.nonce, "transaction.nonce"),
      rlpQuantity(
        transaction.maxPriorityFeePerGas,
        "transaction.maxPriorityFeePerGas"
      ),
      rlpQuantity(transaction.maxFeePerGas, "transaction.maxFeePerGas"),
      rlpQuantity(transaction.gas, "transaction.gas"),
      transactionTo(transaction.to),
      rlpQuantity(transaction.value, "transaction.value"),
      input,
      encodeAccessList(transaction.accessList, "transaction.accessList"),
      rlpQuantity(transaction.maxFeePerBlobGas, "transaction.maxFeePerBlobGas"),
      asArray(
        transaction.blobVersionedHashes,
        "transaction.blobVersionedHashes"
      ).map((hash, index) =>
        fixedHex(hash, 32, `transaction.blobVersionedHashes[${index}]`)
      ),
      rlpQuantity(yParity, "transaction.yParity"),
      rlpQuantity(transaction.r, "transaction.r"),
      rlpQuantity(transaction.s, "transaction.s"),
    ]
  } else if (type === 4) {
    payload = [
      rlpQuantity(transaction.chainId, "transaction.chainId"),
      rlpQuantity(transaction.nonce, "transaction.nonce"),
      rlpQuantity(
        transaction.maxPriorityFeePerGas,
        "transaction.maxPriorityFeePerGas"
      ),
      rlpQuantity(transaction.maxFeePerGas, "transaction.maxFeePerGas"),
      rlpQuantity(transaction.gas, "transaction.gas"),
      transactionTo(transaction.to),
      rlpQuantity(transaction.value, "transaction.value"),
      input,
      encodeAccessList(transaction.accessList, "transaction.accessList"),
      encodeAuthorizationList(transaction.authorizationList),
      rlpQuantity(yParity, "transaction.yParity"),
      rlpQuantity(transaction.r, "transaction.r"),
      rlpQuantity(transaction.s, "transaction.s"),
    ]
  } else {
    throw new Error(`unsupported transaction type ${type}`)
  }

  return ethers.utils.hexConcat([
    typedTransactionPrefix(type),
    ethers.utils.RLP.encode(payload),
  ])
}

function encodeReceiptLogs(value: unknown): unknown[] {
  return asArray(value, "receipt.logs").map((logValue, index) => {
    const log = asRecord(logValue, `receipt.logs[${index}]`)
    return [
      fixedHex(log.address, 20, `receipt.logs[${index}].address`),
      asArray(log.topics, `receipt.logs[${index}].topics`).map(
        (topic, topicIndex) =>
          fixedHex(topic, 32, `receipt.logs[${index}].topics[${topicIndex}]`)
      ),
      normalizedHex(log.data, `receipt.logs[${index}].data`),
    ]
  })
}

export function serializeRpcReceipt(receiptValue: unknown): string {
  const receipt = asRecord(receiptValue, "receipt")
  const type = numberQuantity(receipt.type ?? 0, "receipt.type")
  const statusOrRoot =
    receipt.status !== undefined && receipt.status !== null
      ? rlpQuantity(receipt.status, "receipt.status")
      : fixedHex(receipt.root, 32, "receipt.root")
  const payload = ethers.utils.RLP.encode([
    statusOrRoot,
    rlpQuantity(receipt.cumulativeGasUsed, "receipt.cumulativeGasUsed"),
    fixedHex(receipt.logsBloom, 256, "receipt.logsBloom"),
    encodeReceiptLogs(receipt.logs),
  ])
  if (type === 0) return payload
  return ethers.utils.hexConcat([typedTransactionPrefix(type), payload])
}

function headerField(block: RpcRecord, field: string, length: number): string {
  return fixedHex(block[field], length, `block.${field}`)
}

export function computeRpcBlockHash(blockValue: unknown): string {
  const block = asRecord(blockValue, "block")
  const header: Array<string | unknown[]> = [
    headerField(block, "parentHash", 32),
    headerField(block, "sha3Uncles", 32),
    headerField(block, "miner", 20),
    headerField(block, "stateRoot", 32),
    headerField(block, "transactionsRoot", 32),
    headerField(block, "receiptsRoot", 32),
    headerField(block, "logsBloom", 256),
    rlpQuantity(block.difficulty, "block.difficulty"),
    rlpQuantity(block.number, "block.number"),
    rlpQuantity(block.gasLimit, "block.gasLimit"),
    rlpQuantity(block.gasUsed, "block.gasUsed"),
    rlpQuantity(block.timestamp, "block.timestamp"),
    normalizedHex(block.extraData, "block.extraData"),
    fixedHex(block.mixHash ?? block.prevRandao, 32, "block.mixHash"),
    fixedHex(block.nonce, 8, "block.nonce"),
  ]
  optionalQuantity(block, "baseFeePerGas", header)
  if (block.withdrawalsRoot !== undefined && block.withdrawalsRoot !== null) {
    header.push(headerField(block, "withdrawalsRoot", 32))
  }
  optionalQuantity(block, "blobGasUsed", header)
  optionalQuantity(block, "excessBlobGas", header)
  if (
    block.parentBeaconBlockRoot !== undefined &&
    block.parentBeaconBlockRoot !== null
  ) {
    header.push(headerField(block, "parentBeaconBlockRoot", 32))
  }
  if (block.requestsHash !== undefined && block.requestsHash !== null) {
    header.push(headerField(block, "requestsHash", 32))
  }
  if (
    block.blockAccessListHash !== undefined &&
    block.blockAccessListHash !== null
  ) {
    header.push(headerField(block, "blockAccessListHash", 32))
  }
  return ethers.utils.keccak256(ethers.utils.RLP.encode(header))
}

async function trieRoot(values: string[]): Promise<string> {
  if (values.length === 0) return EMPTY_TRIE_ROOT
  const trie = new Trie()
  for (let index = 0; index < values.length; index++) {
    const key = ethers.utils.RLP.encode(rlpQuantity(index, "trie index"))
    // Keep writes serialized because trie mutation is stateful.
    // eslint-disable-next-line no-await-in-loop
    await new Promise<void>((resolve, reject) => {
      trie.put(
        Buffer.from(ethers.utils.arrayify(key)),
        Buffer.from(ethers.utils.arrayify(values[index])),
        (error: Error | null) => (error ? reject(error) : resolve())
      )
    })
  }
  return ethers.utils.hexlify(trie.root).toLowerCase()
}

function rollingHash(current: string, domain: string, value: string): string {
  return ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ["bytes32", "bytes32", "bytes32"],
      [domain, current, value]
    )
  )
}

function logCommitment(log: providers.Log): string {
  return ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      [
        "bytes32",
        "uint256",
        "bytes32",
        "uint256",
        "uint256",
        "address",
        "bytes32[]",
        "bytes",
      ],
      [
        LOG_DOMAIN,
        log.blockNumber,
        log.transactionHash,
        log.transactionIndex,
        log.logIndex,
        log.address,
        log.topics,
        log.data,
      ]
    )
  )
}

function toProviderLog(
  logValue: unknown,
  blockNumber: number,
  blockHash: string,
  transactionHash: string,
  transactionIndex: number,
  expectedLogIndex: number
): providers.Log {
  const log = asRecord(logValue, `receipt log ${expectedLogIndex}`)
  if (log.removed === true)
    throw new Error("canonical receipt contains removed log")
  if (numberQuantity(log.logIndex, "log.logIndex") !== expectedLogIndex) {
    throw new Error("receipt log indices are not contiguous")
  }
  if (numberQuantity(log.blockNumber, "log.blockNumber") !== blockNumber) {
    throw new Error("receipt log block number mismatch")
  }
  if (
    fixedHex(log.blockHash, 32, "log.blockHash") !== blockHash.toLowerCase()
  ) {
    throw new Error("receipt log block hash mismatch")
  }
  if (
    fixedHex(log.transactionHash, 32, "log.transactionHash") !==
    transactionHash.toLowerCase()
  ) {
    throw new Error("receipt log transaction hash mismatch")
  }
  if (
    numberQuantity(log.transactionIndex, "log.transactionIndex") !==
    transactionIndex
  ) {
    throw new Error("receipt log transaction index mismatch")
  }
  return {
    address: ethers.utils.getAddress(fixedHex(log.address, 20, "log.address")),
    blockHash,
    blockNumber,
    data: normalizedHex(log.data, "log.data"),
    logIndex: expectedLogIndex,
    removed: false,
    topics: asArray(log.topics, "log.topics").map((topic, index) =>
      fixedHex(topic, 32, `log.topics[${index}]`)
    ),
    transactionHash,
    transactionIndex,
  }
}

function requireRpcProvider(provider: providers.Provider): JsonRpcProvider {
  const candidate = provider as JsonRpcProvider
  if (typeof candidate.send !== "function") {
    throw new Error(
      "receipt-complete canonical history requires a JSON-RPC provider"
    )
  }
  return candidate
}

function normalizeEmitters(
  emitters: CanonicalHistoryEmitter[]
): CanonicalHistoryEmitter[] {
  if (emitters.length === 0) {
    throw new Error("canonical history emitter set is empty")
  }
  const seen = new Set<string>()
  return emitters.map((emitter, index) => {
    const address = ethers.utils.getAddress(emitter.address)
    const key = address.toLowerCase()
    if (seen.has(key)) {
      throw new Error(`duplicate canonical history emitter ${address}`)
    }
    seen.add(key)
    const runtimeCodeHash = fixedHex(
      emitter.runtimeCodeHash,
      32,
      `emitters[${index}].runtimeCodeHash`
    )
    if (runtimeCodeHash === ethers.constants.HashZero) {
      throw new Error(`canonical history emitter ${address} has zero code hash`)
    }
    return { address, runtimeCodeHash }
  })
}

export function canonicalEmitterSetCommitment(
  emitters: CanonicalHistoryEmitter[]
): string {
  const normalized = normalizeEmitters(emitters)
  return ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ["bytes32", "tuple(address emitter,bytes32 runtimeCodeHash)[]"],
      [
        EMITTER_SET_DOMAIN,
        normalized.map(({ address, runtimeCodeHash }) => ({
          emitter: address,
          runtimeCodeHash,
        })),
      ]
    )
  )
}

function recomputeEmitterLogDigest(logs: providers.Log[]): string {
  let digest = ethers.constants.HashZero
  let previousBlock = -1
  let previousLogIndex = -1
  logs.forEach((log) => {
    if (
      log.blockNumber < previousBlock ||
      (log.blockNumber === previousBlock && log.logIndex <= previousLogIndex)
    ) {
      throw new Error("checkpoint emitter logs are not strictly ordered")
    }
    previousBlock = log.blockNumber
    previousLogIndex = log.logIndex
    digest = rollingHash(digest, LOG_DOMAIN, logCommitment(log))
  })
  return digest
}

function validateCheckpoint(
  checkpoint: CanonicalHistoryScan,
  chainId: number,
  emitters: CanonicalHistoryEmitter[],
  scanStartBlock: number,
  finalizedBlock: number,
  selectedTopics: Set<string>,
  candidateSelector: string
): void {
  const { evidence } = checkpoint
  const emitterSetCommitment = canonicalEmitterSetCommitment(emitters)
  if (
    evidence.chainId !== chainId ||
    evidence.scanStartBlock !== scanStartBlock ||
    evidence.finalizedBlock < scanStartBlock ||
    evidence.finalizedBlock > finalizedBlock ||
    evidence.blockCount !== evidence.finalizedBlock - scanStartBlock + 1 ||
    evidence.transactionCount !== evidence.receiptCount ||
    evidence.emitterSetCommitment.toLowerCase() !==
      emitterSetCommitment.toLowerCase() ||
    canonicalEmitterSetCommitment(checkpoint.emitters).toLowerCase() !==
      emitterSetCommitment.toLowerCase() ||
    checkpoint.emitterLogs.length !== evidence.emitterLogCount ||
    recomputeEmitterLogDigest(checkpoint.emitterLogs).toLowerCase() !==
      evidence.emitterLogDigest.toLowerCase() ||
    checkpoint.candidateCalls.length !== evidence.candidateCallCount ||
    recomputeCandidateCallDigest(checkpoint.candidateCalls).toLowerCase() !==
      evidence.candidateCallDigest.toLowerCase() ||
    checkpoint.candidateCalls.some(
      (call) =>
        call.input.slice(0, 10).toLowerCase() !== candidateSelector ||
        !emitters.some(
          ({ address }) => address.toLowerCase() === call.to.toLowerCase()
        )
    )
  ) {
    throw new Error("canonical history checkpoint is malformed or incompatible")
  }
  const emitterSet = new Set(
    emitters.map(({ address }) => address.toLowerCase())
  )
  checkpoint.emitterLogs.forEach((log) => {
    if (
      log.removed ||
      log.blockNumber < scanStartBlock ||
      log.blockNumber > evidence.finalizedBlock ||
      !emitterSet.has(log.address.toLowerCase())
    ) {
      throw new Error(
        "canonical history checkpoint contains an invalid emitter log"
      )
    }
  })
  const derivedSelected = checkpoint.emitterLogs.filter(
    (log) => log.topics[0] && selectedTopics.has(log.topics[0].toLowerCase())
  )
  if (
    sourceLogListHash(derivedSelected) !==
    sourceLogListHash(checkpoint.selectedLogs)
  ) {
    throw new Error(
      "canonical history checkpoint selected-log view is inconsistent"
    )
  }
}

function sourceLogListHash(logs: providers.Log[]): string {
  return ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ["bytes32[]"],
      [logs.map((log) => logCommitment(log))]
    )
  )
}

type CallTraceFrame = {
  from?: string
  to?: string
  input?: string
  value?: string
  error?: string
  calls?: CallTraceFrame[]
}

function collectCandidateCalls(
  frame: CallTraceFrame,
  transactionHash: string,
  emitterSet: Set<string>,
  candidateSelector: string,
  output: CanonicalCandidateCall[]
): void {
  if (frame.error) return
  if (
    frame.from &&
    frame.to &&
    frame.input &&
    emitterSet.has(frame.to.toLowerCase()) &&
    frame.input.slice(0, 10).toLowerCase() === candidateSelector
  ) {
    output.push({
      transactionHash,
      from: ethers.utils.getAddress(frame.from),
      to: ethers.utils.getAddress(frame.to),
      input: normalizedHex(frame.input, "trace input"),
      value: quantity(frame.value ?? 0, "trace value").toString(),
    })
  }
  const childFrames = frame.calls ?? []
  childFrames.forEach((child) =>
    collectCandidateCalls(
      child,
      transactionHash,
      emitterSet,
      candidateSelector,
      output
    )
  )
}

function candidateCallCommitment(call: CanonicalCandidateCall): string {
  return ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ["bytes32", "bytes32", "address", "address", "bytes", "uint256"],
      [
        CANDIDATE_CALL_DOMAIN,
        call.transactionHash,
        call.from,
        call.to,
        call.input,
        call.value,
      ]
    )
  )
}

function recomputeCandidateCallDigest(calls: CanonicalCandidateCall[]): string {
  let digest = ethers.constants.HashZero
  calls.forEach((call) => {
    digest = rollingHash(
      digest,
      CANDIDATE_CALL_DOMAIN,
      candidateCallCommitment(call)
    )
  })
  return digest
}

export async function scanCanonicalHistory(
  provider: providers.Provider,
  historyEmitters: CanonicalHistoryEmitter[],
  scanStartBlock: number,
  finalizedBlock: number,
  selectedTopics: string[],
  candidateCallSelector: string,
  checkpoint?: CanonicalHistoryScan
): Promise<CanonicalHistoryScan> {
  if (
    !Number.isSafeInteger(scanStartBlock) ||
    !Number.isSafeInteger(finalizedBlock) ||
    scanStartBlock < 0 ||
    finalizedBlock < scanStartBlock
  ) {
    throw new Error("canonical history scan range is invalid")
  }
  const rpc = requireRpcProvider(provider)
  const emitters = normalizeEmitters(historyEmitters)
  const bridge = emitters[0].address
  const emitterSet = new Set(
    emitters.map(({ address }) => address.toLowerCase())
  )
  const emitterSetCommitment = canonicalEmitterSetCommitment(emitters)
  const topicSet = new Set(selectedTopics.map((topic) => topic.toLowerCase()))
  const candidateSelector = fixedHex(
    candidateCallSelector,
    4,
    "candidate call selector"
  )
  const { chainId } = await provider.getNetwork()
  if (checkpoint) {
    validateCheckpoint(
      checkpoint,
      chainId,
      emitters,
      scanStartBlock,
      finalizedBlock,
      topicSet,
      candidateSelector
    )
    const checkpointReadback = asRecord(
      await rpc.send("eth_getBlockByNumber", [
        ethers.utils.hexValue(checkpoint.evidence.finalizedBlock),
        false,
      ]),
      "checkpoint block readback"
    )
    if (
      fixedHex(checkpointReadback.hash, 32, "checkpoint block hash") !==
      checkpoint.evidence.finalizedBlockHash.toLowerCase()
    ) {
      throw new Error("canonical history checkpoint is stale after a reorg")
    }
  }
  const selectedLogs: providers.Log[] = checkpoint
    ? [...checkpoint.selectedLogs]
    : []
  const emitterLogs: providers.Log[] = checkpoint
    ? [...checkpoint.emitterLogs]
    : []
  const selectedTransactions: CanonicalHistoryScan["selectedTransactions"] =
    checkpoint ? { ...checkpoint.selectedTransactions } : {}
  const candidateCalls: CanonicalCandidateCall[] = checkpoint
    ? [...checkpoint.candidateCalls]
    : []
  let previousBlockHash = checkpoint?.evidence.finalizedBlockHash ?? ""
  let startParentHash = checkpoint?.evidence.startParentHash ?? ""
  let startBlockHash = checkpoint?.evidence.startBlockHash ?? ""
  let historyCommitment =
    checkpoint?.evidence.historyCommitment ??
    ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        ["bytes32", "uint256", "address", "bytes32", "uint256"],
        [HISTORY_DOMAIN, chainId, bridge, emitterSetCommitment, scanStartBlock]
      )
    )
  let transactionCount = checkpoint?.evidence.transactionCount ?? 0
  let receiptCount = checkpoint?.evidence.receiptCount ?? 0
  let logCount = checkpoint?.evidence.logCount ?? 0
  let emitterLogCount = checkpoint?.evidence.emitterLogCount ?? 0
  let emitterLogDigest =
    checkpoint?.evidence.emitterLogDigest ?? ethers.constants.HashZero
  let candidateCallDigest =
    checkpoint?.evidence.candidateCallDigest ?? ethers.constants.HashZero
  const firstBlock = checkpoint
    ? checkpoint.evidence.finalizedBlock + 1
    : scanStartBlock

  for (
    let blockNumber = firstBlock;
    blockNumber <= finalizedBlock;
    blockNumber++
  ) {
    // Full transaction objects are required so the transaction trie can be
    // recomputed rather than trusting hashes returned alongside receipts.
    // eslint-disable-next-line no-await-in-loop
    const blockValue = await rpc.send("eth_getBlockByNumber", [
      ethers.utils.hexValue(blockNumber),
      true,
    ])
    const block = asRecord(blockValue, `block ${blockNumber}`)
    if (numberQuantity(block.number, "block.number") !== blockNumber) {
      throw new Error(`canonical block number mismatch at ${blockNumber}`)
    }
    const blockHash = fixedHex(block.hash, 32, "block.hash")
    const computedBlockHash = computeRpcBlockHash(block)
    if (computedBlockHash !== blockHash) {
      throw new Error(`canonical block header hash mismatch at ${blockNumber}`)
    }
    const parentHash = headerField(block, "parentHash", 32)
    if (blockNumber === scanStartBlock) {
      startParentHash = parentHash
      startBlockHash = blockHash
    } else if (parentHash !== previousBlockHash) {
      throw new Error(`canonical block ancestry mismatch at ${blockNumber}`)
    }

    const transactions = asArray(block.transactions, "block.transactions")
    const serializedTransactions: string[] = []
    const serializedReceipts: string[] = []
    let blockReceiptDigest = ethers.constants.HashZero
    let blockLogIndex = 0
    let blockEmitterLogCount = 0
    let blockEmitterLogDigest = ethers.constants.HashZero
    const blockCandidateCalls: CanonicalCandidateCall[] = []

    for (
      let transactionIndex = 0;
      transactionIndex < transactions.length;
      transactionIndex++
    ) {
      const transaction = asRecord(
        transactions[transactionIndex],
        `block.transactions[${transactionIndex}]`
      )
      if (
        numberQuantity(transaction.blockNumber, "transaction.blockNumber") !==
          blockNumber ||
        fixedHex(transaction.blockHash, 32, "transaction.blockHash") !==
          blockHash ||
        numberQuantity(
          transaction.transactionIndex,
          "transaction.transactionIndex"
        ) !== transactionIndex
      ) {
        throw new Error(
          `transaction block/order mismatch at ${blockNumber}:${transactionIndex}`
        )
      }
      const transactionHash = fixedHex(transaction.hash, 32, "transaction.hash")
      const serializedTransaction = serializeRpcTransaction(transaction)
      if (ethers.utils.keccak256(serializedTransaction) !== transactionHash) {
        throw new Error(
          `transaction hash mismatch at ${blockNumber}:${transactionIndex}`
        )
      }
      serializedTransactions.push(serializedTransaction)

      // Fetch every receipt by the transaction list committed in the header.
      // A provider cap or omitted receipt is therefore an explicit failure.
      // eslint-disable-next-line no-await-in-loop
      const receiptValue = await rpc.send("eth_getTransactionReceipt", [
        transactionHash,
      ])
      const receipt = asRecord(
        receiptValue,
        `receipt ${blockNumber}:${transactionIndex}`
      )
      if (
        fixedHex(receipt.transactionHash, 32, "receipt.transactionHash") !==
          transactionHash ||
        numberQuantity(receipt.blockNumber, "receipt.blockNumber") !==
          blockNumber ||
        fixedHex(receipt.blockHash, 32, "receipt.blockHash") !== blockHash ||
        numberQuantity(receipt.transactionIndex, "receipt.transactionIndex") !==
          transactionIndex
      ) {
        throw new Error(
          `receipt transaction/block/order mismatch at ${blockNumber}:${transactionIndex}`
        )
      }
      const serializedReceipt = serializeRpcReceipt(receipt)
      serializedReceipts.push(serializedReceipt)

      let receiptLogDigest = ethers.constants.HashZero
      const receiptLogs = asArray(receipt.logs, "receipt.logs")
      for (const receiptLog of receiptLogs) {
        const log = toProviderLog(
          receiptLog,
          blockNumber,
          blockHash,
          transactionHash,
          transactionIndex,
          blockLogIndex
        )
        blockLogIndex++
        const commitment = logCommitment(log)
        receiptLogDigest = rollingHash(receiptLogDigest, LOG_DOMAIN, commitment)
        if (emitterSet.has(log.address.toLowerCase())) {
          blockEmitterLogCount++
          emitterLogs.push(log)
          blockEmitterLogDigest = rollingHash(
            blockEmitterLogDigest,
            LOG_DOMAIN,
            commitment
          )
          emitterLogDigest = rollingHash(
            emitterLogDigest,
            LOG_DOMAIN,
            commitment
          )
          if (log.topics[0] && topicSet.has(log.topics[0].toLowerCase())) {
            selectedLogs.push(log)
            selectedTransactions[transactionHash] = {
              from: ethers.utils.getAddress(
                fixedHex(transaction.from, 20, "transaction.from")
              ),
              to:
                transaction.to === null || transaction.to === undefined
                  ? null
                  : ethers.utils.getAddress(
                      fixedHex(transaction.to, 20, "transaction.to")
                    ),
              data: normalizedHex(
                transaction.input ?? transaction.data ?? "0x",
                "transaction.input"
              ),
              value: quantity(
                transaction.value,
                "transaction.value"
              ).toString(),
            }
          }
        }
      }
      const receiptCommitment = ethers.utils.keccak256(
        ethers.utils.defaultAbiCoder.encode(
          ["bytes32", "bytes32", "uint256", "bytes32", "uint256", "bytes32"],
          [
            RECEIPT_DOMAIN,
            transactionHash,
            transactionIndex,
            ethers.utils.keccak256(serializedReceipt),
            receiptLogs.length,
            receiptLogDigest,
          ]
        )
      )
      blockReceiptDigest = rollingHash(
        blockReceiptDigest,
        RECEIPT_DOMAIN,
        receiptCommitment
      )
    }

    // Trace the exact header-committed transaction list in one block-scoped
    // call. This catches successful forwarded submissions that omit their
    // required lifecycle log; tracing only event-bearing transactions would
    // make that omission invisible.
    // eslint-disable-next-line no-await-in-loop
    const traceValues = asArray(
      await rpc.send("debug_traceBlockByHash", [
        blockHash,
        { tracer: "callTracer", timeout: "120s" },
      ]),
      `block traces ${blockNumber}`
    )
    if (traceValues.length !== transactions.length) {
      throw new Error(`block trace count mismatch at ${blockNumber}`)
    }
    traceValues.forEach((traceValue, transactionIndex) => {
      const trace = asRecord(
        traceValue,
        `block trace ${blockNumber}:${transactionIndex}`
      )
      const transaction = asRecord(
        transactions[transactionIndex],
        `block.transactions[${transactionIndex}]`
      )
      const transactionHash = fixedHex(transaction.hash, 32, "transaction.hash")
      if (
        trace.txHash !== undefined &&
        fixedHex(trace.txHash, 32, "trace.txHash") !== transactionHash
      ) {
        throw new Error(`block trace order mismatch at ${blockNumber}`)
      }
      const frame = (trace.result ?? trace) as CallTraceFrame
      collectCandidateCalls(
        frame,
        transactionHash,
        emitterSet,
        candidateSelector,
        blockCandidateCalls
      )
    })
    candidateCalls.push(...blockCandidateCalls)
    candidateCallDigest = blockCandidateCalls.reduce(
      (digest, call) =>
        rollingHash(
          digest,
          CANDIDATE_CALL_DOMAIN,
          candidateCallCommitment(call)
        ),
      candidateCallDigest
    )

    // Recomputed roots are the completeness boundary. Enumeration that is
    // missing a transaction, receipt, or log cannot match the canonical header.
    // eslint-disable-next-line no-await-in-loop
    const computedTransactionsRoot = await trieRoot(serializedTransactions)
    // eslint-disable-next-line no-await-in-loop
    const computedReceiptsRoot = await trieRoot(serializedReceipts)
    if (
      computedTransactionsRoot !== headerField(block, "transactionsRoot", 32)
    ) {
      throw new Error(`transaction trie root mismatch at ${blockNumber}`)
    }
    if (computedReceiptsRoot !== headerField(block, "receiptsRoot", 32)) {
      throw new Error(`receipt trie root mismatch at ${blockNumber}`)
    }

    const blockCommitment = ethers.utils.keccak256(
      ethers.utils.defaultAbiCoder.encode(
        [
          "bytes32",
          "uint256",
          "bytes32",
          "bytes32",
          "bytes32",
          "bytes32",
          "uint256",
          "uint256",
          "uint256",
          "bytes32",
          "uint256",
          "bytes32",
          "uint256",
          "bytes32",
        ],
        [
          BLOCK_DOMAIN,
          blockNumber,
          blockHash,
          parentHash,
          computedTransactionsRoot,
          computedReceiptsRoot,
          transactions.length,
          serializedReceipts.length,
          blockLogIndex,
          blockReceiptDigest,
          blockEmitterLogCount,
          blockEmitterLogDigest,
          blockCandidateCalls.length,
          recomputeCandidateCallDigest(blockCandidateCalls),
        ]
      )
    )
    historyCommitment = rollingHash(
      historyCommitment,
      HISTORY_DOMAIN,
      blockCommitment
    )
    transactionCount += transactions.length
    receiptCount += serializedReceipts.length
    logCount += blockLogIndex
    emitterLogCount += blockEmitterLogCount
    previousBlockHash = blockHash
  }

  // Detect a reorg that occurred after the loop reached the final block.
  const finalizedReadback = asRecord(
    await rpc.send("eth_getBlockByNumber", [
      ethers.utils.hexValue(finalizedBlock),
      false,
    ]),
    `finalized block ${finalizedBlock} readback`
  )
  if (
    fixedHex(finalizedReadback.hash, 32, "finalized block hash") !==
    previousBlockHash
  ) {
    throw new Error("canonical history reorg detected during scan")
  }

  await Promise.all(
    emitters.map(async ({ address, runtimeCodeHash }) => {
      const code = await provider.getCode(address)
      if (
        code === "0x" ||
        ethers.utils.keccak256(code).toLowerCase() !==
          runtimeCodeHash.toLowerCase()
      ) {
        throw new Error(
          `canonical history emitter code hash mismatch for ${address}`
        )
      }
    })
  )

  return {
    evidence: {
      chainId,
      bridge,
      emitterSetCommitment,
      scanStartBlock,
      finalizedBlock,
      startParentHash,
      startBlockHash,
      finalizedBlockHash: previousBlockHash,
      historyCommitment,
      blockCount: finalizedBlock - scanStartBlock + 1,
      transactionCount,
      receiptCount,
      logCount,
      emitterLogCount,
      emitterLogDigest,
      candidateCallCount: candidateCalls.length,
      candidateCallDigest,
    },
    emitters,
    emitterLogs,
    selectedLogs,
    candidateCalls,
    selectedTransactions,
  }
}
