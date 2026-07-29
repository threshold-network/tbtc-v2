/* eslint-disable no-restricted-syntax, no-plusplus */

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
  ethers.utils.toUtf8Bytes("tbtc/frost-wallet-archive/canonical-history/v1")
)
const BLOCK_DOMAIN = ethers.utils.keccak256(
  ethers.utils.toUtf8Bytes("tbtc/frost-wallet-archive/canonical-block/v1")
)
const RECEIPT_DOMAIN = ethers.utils.keccak256(
  ethers.utils.toUtf8Bytes("tbtc/frost-wallet-archive/canonical-receipt/v1")
)
const LOG_DOMAIN = ethers.utils.keccak256(
  ethers.utils.toUtf8Bytes("tbtc/frost-wallet-archive/canonical-log/v1")
)

type RpcRecord = Record<string, unknown>

export type CanonicalHistoryEvidence = {
  chainId: number
  registry: string
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
  registryLogCount: number
  registryLogDigest: string
  selectedLogCount: number
  selectedLogDigest: string
  selectionUpperExclusive: CanonicalLogPosition | null
}

export type CanonicalLogPosition = {
  blockNumber: number
  transactionIndex: number
  logIndex: number
}

export type CanonicalHistoryScan = {
  evidence: CanonicalHistoryEvidence
  allLogs: providers.Log[]
  selectedLogs: providers.Log[]
  selectedTransactions: Record<
    string,
    { from: string; to: string | null; data: string; value: string }
  >
}

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
  // BigNumber emits the minimal even-length byte representation expected by
  // RLP (for example 2 => 0x02). hexStripZeros would produce odd-length 0x2.
  return number.toHexString()
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
  if (type < 0 || type > 4) {
    throw new Error(`unsupported receipt type ${type}`)
  }
  if (
    receipt.status !== undefined &&
    receipt.status !== null &&
    !quantity(receipt.status, "receipt.status").eq(0) &&
    !quantity(receipt.status, "receipt.status").eq(1)
  ) {
    throw new Error("unsupported receipt status")
  }
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
  const hasWithdrawals =
    block.withdrawalsRoot !== undefined && block.withdrawalsRoot !== null
  const hasBlobGas =
    block.blobGasUsed !== undefined && block.blobGasUsed !== null
  const hasExcessBlobGas =
    block.excessBlobGas !== undefined && block.excessBlobGas !== null
  const hasParentBeacon =
    block.parentBeaconBlockRoot !== undefined &&
    block.parentBeaconBlockRoot !== null
  const hasRequests =
    block.requestsHash !== undefined && block.requestsHash !== null
  const hasBlockAccessList =
    block.blockAccessListHash !== undefined &&
    block.blockAccessListHash !== null
  if (
    hasBlobGas !== hasExcessBlobGas ||
    hasBlobGas !== hasParentBeacon ||
    (hasBlobGas && !hasWithdrawals) ||
    (hasRequests && !hasParentBeacon) ||
    (hasBlockAccessList && !hasRequests)
  ) {
    throw new Error("unsupported block header field combination")
  }
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
  if (hasWithdrawals) {
    header.push(headerField(block, "withdrawalsRoot", 32))
  }
  optionalQuantity(block, "blobGasUsed", header)
  optionalQuantity(block, "excessBlobGas", header)
  if (hasParentBeacon) {
    header.push(headerField(block, "parentBeaconBlockRoot", 32))
  }
  if (hasRequests) {
    header.push(headerField(block, "requestsHash", 32))
  }
  if (hasBlockAccessList) {
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

function beforePosition(
  log: providers.Log,
  upperExclusive?: CanonicalLogPosition
): boolean {
  if (!upperExclusive) return true
  if (log.blockNumber !== upperExclusive.blockNumber) {
    return log.blockNumber < upperExclusive.blockNumber
  }
  if (log.transactionIndex !== upperExclusive.transactionIndex) {
    return log.transactionIndex < upperExclusive.transactionIndex
  }
  return log.logIndex < upperExclusive.logIndex
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

export async function scanCanonicalHistory(
  provider: providers.Provider,
  registryAddress: string,
  scanStartBlock: number,
  finalizedBlock: number,
  selectedTopics: string[],
  selectionUpperExclusive?: CanonicalLogPosition
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
  const registry = ethers.utils.getAddress(registryAddress)
  const topicSet = new Set(selectedTopics.map((topic) => topic.toLowerCase()))
  const { chainId } = await provider.getNetwork()
  const selectedLogs: providers.Log[] = []
  const allLogs: providers.Log[] = []
  const selectedTransactions: CanonicalHistoryScan["selectedTransactions"] = {}
  let previousBlockHash = ""
  let startParentHash = ""
  let startBlockHash = ""
  let historyCommitment = ethers.utils.keccak256(
    ethers.utils.defaultAbiCoder.encode(
      ["bytes32", "uint256", "address", "uint256", "uint256"],
      [HISTORY_DOMAIN, chainId, registry, scanStartBlock, finalizedBlock]
    )
  )
  let transactionCount = 0
  let receiptCount = 0
  let logCount = 0
  let registryLogCount = 0
  let registryLogDigest = ethers.constants.HashZero
  let selectedLogCount = 0
  let selectedLogDigest = ethers.constants.HashZero

  for (
    let blockNumber = scanStartBlock;
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
    let blockRegistryLogCount = 0
    let blockRegistryLogDigest = ethers.constants.HashZero

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
      if (
        numberQuantity(receipt.type ?? 0, "receipt.type") !==
        numberQuantity(transaction.type ?? 0, "transaction.type")
      ) {
        throw new Error(
          `receipt/transaction type mismatch at ${blockNumber}:${transactionIndex}`
        )
      }
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
        allLogs.push(log)
        receiptLogDigest = rollingHash(receiptLogDigest, LOG_DOMAIN, commitment)
        if (log.address.toLowerCase() === registry.toLowerCase()) {
          blockRegistryLogCount++
          blockRegistryLogDigest = rollingHash(
            blockRegistryLogDigest,
            LOG_DOMAIN,
            commitment
          )
          if (
            log.topics[0] &&
            topicSet.has(log.topics[0].toLowerCase()) &&
            beforePosition(log, selectionUpperExclusive)
          ) {
            selectedLogs.push(log)
            selectedLogCount++
            selectedLogDigest = rollingHash(
              selectedLogDigest,
              LOG_DOMAIN,
              commitment
            )
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
          blockRegistryLogCount,
          blockRegistryLogDigest,
        ]
      )
    )
    historyCommitment = rollingHash(
      historyCommitment,
      HISTORY_DOMAIN,
      blockCommitment
    )
    registryLogDigest = rollingHash(
      registryLogDigest,
      LOG_DOMAIN,
      blockRegistryLogDigest
    )
    transactionCount += transactions.length
    receiptCount += serializedReceipts.length
    logCount += blockLogIndex
    registryLogCount += blockRegistryLogCount
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

  return {
    evidence: {
      chainId,
      registry,
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
      registryLogCount,
      registryLogDigest,
      selectedLogCount,
      selectedLogDigest,
      selectionUpperExclusive: selectionUpperExclusive ?? null,
    },
    allLogs,
    selectedLogs,
    selectedTransactions,
  }
}
