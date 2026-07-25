import {
  ETHEREUM_EMPTY_TRIE_ROOT,
  computeP2TREthereumRpcBlockHash,
  computeP2TREthereumTrieRoot,
  hashP2TREthereumSerializedEnvelope,
  serializeP2TREthereumRpcReceipt,
  serializeP2TREthereumRpcTransaction,
} from "../src/EthereumCanonicalHeaderProof.js"
import type {
  P2TRCanonicalEthereumBlock,
  P2TRCanonicalEthereumReceipt,
} from "../src/P2TRCanonicalEthereumJournal.js"

const ZERO_BLOOM = `0x${"00".repeat(256)}`

export function canonicalEmptyBlock(
  blockNumber: number,
  parentHash: string,
  timestamp = blockNumber
): P2TRCanonicalEthereumBlock {
  const canonicalHeader = header(
    blockNumber,
    parentHash,
    timestamp,
    ETHEREUM_EMPTY_TRIE_ROOT,
    ETHEREUM_EMPTY_TRIE_ROOT,
    0
  )
  return {
    blockNumber,
    blockHash: computeP2TREthereumRpcBlockHash(canonicalHeader),
    parentHash,
    timestamp,
    transactionsRoot: ETHEREUM_EMPTY_TRIE_ROOT,
    receiptsRoot: ETHEREUM_EMPTY_TRIE_ROOT,
    canonicalHeader,
    transactionHashes: [],
    serializedTransactions: [],
  }
}

export async function canonicalReceiptCoverageFixture(): Promise<{
  block: P2TRCanonicalEthereumBlock
  receipts: P2TRCanonicalEthereumReceipt[]
  rpcTransactions: ReadonlyArray<Readonly<Record<string, unknown>>>
}> {
  const blockNumber = 10
  const parentHash = hash(9)
  const timestamp = 1_700_000_000
  const transactions = [legacyTransaction(1), legacyTransaction(2)]
  const serializedTransactions = transactions.map(
    serializeP2TREthereumRpcTransaction
  )
  const transactionHashes = serializedTransactions.map(
    hashP2TREthereumSerializedEnvelope
  )
  const provisionalBlockHash = hash(0)
  const log = (transactionIndex: number, logIndex: number) => ({
    address: `0x${"12".repeat(20)}`,
    blockHash: provisionalBlockHash,
    blockNumber,
    transactionHash: transactionHashes[transactionIndex],
    transactionIndex,
    logIndex,
    data: `0x${(logIndex + 1).toString(16).padStart(2, "0")}`,
    topics: [hash(200 + logIndex)],
    removed: false as const,
  })
  const receipts: P2TRCanonicalEthereumReceipt[] = [
    {
      type: 0,
      status: 1,
      cumulativeGasUsed: "0x5208",
      logsBloom: ZERO_BLOOM,
      blockHash: provisionalBlockHash,
      blockNumber,
      transactionHash: transactionHashes[0],
      transactionIndex: 0,
      logs: [log(0, 0), log(0, 1)],
    },
    {
      type: 0,
      status: 1,
      cumulativeGasUsed: "0xa410",
      logsBloom: ZERO_BLOOM,
      blockHash: provisionalBlockHash,
      blockNumber,
      transactionHash: transactionHashes[1],
      transactionIndex: 1,
      logs: [log(1, 2)],
    },
  ]
  const [transactionsRoot, receiptsRoot] = await Promise.all([
    computeP2TREthereumTrieRoot(serializedTransactions),
    computeP2TREthereumTrieRoot(receipts.map(serializeP2TREthereumRpcReceipt)),
  ])
  const canonicalHeader = header(
    blockNumber,
    parentHash,
    timestamp,
    transactionsRoot,
    receiptsRoot,
    0xa410
  )
  const blockHash = computeP2TREthereumRpcBlockHash(canonicalHeader)
  const rpcTransactions = transactions.map((transaction, transactionIndex) =>
    Object.freeze({
      ...transaction,
      blockNumber: quantity(blockNumber),
      blockHash,
      transactionIndex: quantity(transactionIndex),
      hash: transactionHashes[transactionIndex],
    })
  )
  for (const receipt of receipts) {
    receipt.blockHash = blockHash
    receipt.logs = receipt.logs.map((entry) => ({ ...entry, blockHash }))
  }
  return {
    block: {
      blockNumber,
      blockHash,
      parentHash,
      timestamp,
      transactionsRoot,
      receiptsRoot,
      canonicalHeader,
      transactionHashes,
      serializedTransactions,
    },
    receipts,
    rpcTransactions,
  }
}

function legacyTransaction(nonce: number): Record<string, unknown> {
  return {
    type: "0x0",
    nonce: quantity(nonce),
    gasPrice: "0x3b9aca00",
    gas: "0x5208",
    to: `0x${"34".repeat(20)}`,
    value: quantity(nonce),
    input: "0x",
    v: "0x25",
    r: hash(300 + nonce),
    s: hash(400 + nonce),
  }
}

function header(
  blockNumber: number,
  parentHash: string,
  timestamp: number,
  transactionsRoot: string,
  receiptsRoot: string,
  gasUsed: number
): Readonly<Record<string, unknown>> {
  return Object.freeze({
    parentHash,
    sha3Uncles: hash(501),
    miner: `0x${"56".repeat(20)}`,
    stateRoot: hash(502),
    transactionsRoot,
    receiptsRoot,
    logsBloom: ZERO_BLOOM,
    difficulty: "0x0",
    number: quantity(blockNumber),
    gasLimit: "0x1c9c380",
    gasUsed: quantity(gasUsed),
    timestamp: quantity(timestamp),
    extraData: "0x",
    mixHash: hash(503),
    nonce: `0x${"00".repeat(8)}`,
    baseFeePerGas: "0x7",
  })
}

function quantity(value: number): string {
  return `0x${value.toString(16)}`
}

export function hash(value: number): string {
  return `0x${value.toString(16).padStart(64, "0")}`
}
