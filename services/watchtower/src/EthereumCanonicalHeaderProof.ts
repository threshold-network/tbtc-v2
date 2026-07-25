import { createRequire } from "node:module"
import { BigNumber, ethers } from "ethers"

// Reused from the audited ECDSA canonical-history scanner. The trie package is
// deliberately loaded through Node so this ESM service can use its callback
// API without pretending it has a typed/async surface.
const require = createRequire(import.meta.url)
const Trie = require("merkle-patricia-tree") as new () => {
  root: Buffer
  put(key: Buffer, value: Buffer, callback: (error: Error | null) => void): void
}

export const ETHEREUM_EMPTY_TRIE_ROOT =
  "0x56e81f171bcc55a6ff8345e692c0f86e5b48e01b996cadc001622fb5e363b421"

type RpcRecord = Record<string, unknown>

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

function normalizedHex(value: unknown, label: string): string {
  if (typeof value !== "string" || !ethers.utils.isHexString(value)) {
    throw new Error(`${label} is not hex data`)
  }
  return ethers.utils.hexlify(value).toLowerCase()
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
  } catch {
    throw new Error(`${label} is not a canonical quantity`)
  }
}

function rlpQuantity(value: unknown, label: string): string {
  const number = quantity(value, label)
  if (number.isZero()) return "0x"
  // ethers' RLP encoder rejects odd-nibble strings such as `0x1`; hexlify
  // preserves the canonical minimal whole-byte representation (`0x01`).
  return ethers.utils.hexlify(number)
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
    const item = Array.isArray(entry)
      ? { address: entry[0], storageKeys: entry[1] }
      : asRecord(entry, `${label}[${index}]`)
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
  return value === null || value === undefined
    ? "0x"
    : fixedHex(value, 20, "transaction.to")
}

function typedPrefix(type: number): string {
  if (type <= 0 || type > 0x7f) {
    throw new Error(`unsupported typed envelope ${type}`)
  }
  return ethers.utils.hexZeroPad(ethers.utils.hexlify(type), 1)
}

export function serializeP2TREthereumRpcTransaction(value: unknown): string {
  const transaction = asRecord(value, "transaction")
  const type = numberQuantity(transaction.type ?? 0, "transaction.type")
  const input = normalizedHex(
    transaction.input ?? transaction.data ?? "0x",
    "transaction.input"
  )
  const yParity = transaction.yParity ?? transaction.v
  let payload: unknown[]
  if (type === 0) {
    return ethers.utils.RLP.encode([
      rlpQuantity(transaction.nonce, "transaction.nonce"),
      rlpQuantity(transaction.gasPrice, "transaction.gasPrice"),
      rlpQuantity(transaction.gas, "transaction.gas"),
      transactionTo(transaction.to),
      rlpQuantity(transaction.value, "transaction.value"),
      input,
      rlpQuantity(transaction.v, "transaction.v"),
      rlpQuantity(transaction.r, "transaction.r"),
      rlpQuantity(transaction.s, "transaction.s"),
    ])
  }
  const prefix = [
    rlpQuantity(transaction.chainId, "transaction.chainId"),
    rlpQuantity(transaction.nonce, "transaction.nonce"),
  ]
  const gasTail = [
    rlpQuantity(transaction.gas, "transaction.gas"),
    transactionTo(transaction.to),
    rlpQuantity(transaction.value, "transaction.value"),
    input,
    encodeAccessList(transaction.accessList, "transaction.accessList"),
  ]
  if (type === 1) {
    payload = [
      ...prefix,
      rlpQuantity(transaction.gasPrice, "transaction.gasPrice"),
      ...gasTail,
      rlpQuantity(yParity, "transaction.yParity"),
      rlpQuantity(transaction.r, "transaction.r"),
      rlpQuantity(transaction.s, "transaction.s"),
    ]
  } else if (type === 2 || type === 3 || type === 4) {
    payload = [
      ...prefix,
      rlpQuantity(
        transaction.maxPriorityFeePerGas,
        "transaction.maxPriorityFeePerGas"
      ),
      rlpQuantity(transaction.maxFeePerGas, "transaction.maxFeePerGas"),
      ...gasTail,
    ]
    if (type === 3) {
      payload.push(
        rlpQuantity(
          transaction.maxFeePerBlobGas,
          "transaction.maxFeePerBlobGas"
        ),
        asArray(
          transaction.blobVersionedHashes,
          "transaction.blobVersionedHashes"
        ).map((hash, index) =>
          fixedHex(hash, 32, `transaction.blobVersionedHashes[${index}]`)
        )
      )
    } else if (type === 4) {
      payload.push(encodeAuthorizationList(transaction.authorizationList))
    }
    payload.push(
      rlpQuantity(yParity, "transaction.yParity"),
      rlpQuantity(transaction.r, "transaction.r"),
      rlpQuantity(transaction.s, "transaction.s")
    )
  } else {
    throw new Error(`unsupported transaction type ${type}`)
  }
  return ethers.utils.hexConcat([
    typedPrefix(type),
    ethers.utils.RLP.encode(payload),
  ])
}

function encodeReceiptLogs(value: unknown): unknown[] {
  return asArray(value, "receipt.logs").map((entry, index) => {
    const log = asRecord(entry, `receipt.logs[${index}]`)
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

export function serializeP2TREthereumRpcReceipt(value: unknown): string {
  const receipt = asRecord(value, "receipt")
  const type = numberQuantity(receipt.type ?? 0, "receipt.type")
  if (type > 4) throw new Error(`unsupported receipt type ${type}`)
  if (
    receipt.status === undefined ||
    receipt.status === null ||
    (receipt.root !== undefined && receipt.root !== null)
  ) {
    throw new Error(
      "post-Byzantium receipt must contain status and no state root"
    )
  }
  const status = numberQuantity(receipt.status, "receipt.status")
  if (status !== 0 && status !== 1) {
    throw new Error("receipt.status must be zero or one")
  }
  const payload = ethers.utils.RLP.encode([
    rlpQuantity(status, "receipt.status"),
    rlpQuantity(receipt.cumulativeGasUsed, "receipt.cumulativeGasUsed"),
    fixedHex(receipt.logsBloom, 256, "receipt.logsBloom"),
    encodeReceiptLogs(receipt.logs),
  ])
  return type === 0
    ? payload
    : ethers.utils.hexConcat([typedPrefix(type), payload])
}

function headerField(block: RpcRecord, field: string, length: number): string {
  return fixedHex(block[field], length, `block.${field}`)
}

export function computeP2TREthereumRpcBlockHash(value: unknown): string {
  const block = asRecord(value, "block")
  assertForkHeaderStructure(block)
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

function assertForkHeaderStructure(block: RpcRecord): void {
  const present = (field: string) =>
    block[field] !== undefined && block[field] !== null
  const baseFee = present("baseFeePerGas")
  const withdrawals = present("withdrawalsRoot")
  const blobGasUsed = present("blobGasUsed")
  const excessBlobGas = present("excessBlobGas")
  const beaconRoot = present("parentBeaconBlockRoot")
  const requestsHash = present("requestsHash")
  const blockAccessListHash = present("blockAccessListHash")
  const cancunFieldCount =
    Number(blobGasUsed) + Number(excessBlobGas) + Number(beaconRoot)
  if (
    (withdrawals && !baseFee) ||
    (cancunFieldCount !== 0 && cancunFieldCount !== 3) ||
    (cancunFieldCount === 3 && (!baseFee || !withdrawals)) ||
    (requestsHash && cancunFieldCount !== 3) ||
    (blockAccessListHash && !requestsHash)
  ) {
    throw new Error(
      "Ethereum block has an impossible fork header field combination"
    )
  }
}

export async function computeP2TREthereumTrieRoot(
  serializedValues: readonly string[]
): Promise<string> {
  if (serializedValues.length === 0) return ETHEREUM_EMPTY_TRIE_ROOT
  const trie = new Trie()
  for (let index = 0; index < serializedValues.length; index++) {
    const key = ethers.utils.RLP.encode(rlpQuantity(index, "trie index"))
    await new Promise<void>((resolve, reject) => {
      trie.put(
        Buffer.from(ethers.utils.arrayify(key)),
        Buffer.from(ethers.utils.arrayify(serializedValues[index])),
        (error) => (error ? reject(error) : resolve())
      )
    })
  }
  return ethers.utils.hexlify(trie.root).toLowerCase()
}

export function hashP2TREthereumSerializedEnvelope(value: string): string {
  return ethers.utils.keccak256(normalizedHex(value, "serialized envelope"))
}
