import { isDeepStrictEqual } from "util"
import {
  Transaction,
  decodeRlp,
  encodeRlp,
  getBytes,
  getCreateAddress,
  id,
  keccak256,
  toBeHex,
} from "ethers"

// JSON-RPC evidence is checked at runtime; never use this as a live RPC client.
export type Json = any

export function check(condition: boolean, label: string): asserts condition {
  if (!condition) throw new Error(label)
}

export function same(actual: unknown, expected: unknown, label: string): void {
  check(isDeepStrictEqual(actual, expected), label)
}

const quantity = (value: string) =>
  BigInt(value) === 0n ? "0x" : toBeHex(BigInt(value))
const word = (address: string) => toBeHex(BigInt(address), 32)
const addressFromWord = (value: string) => `0x${value.slice(-40)}`
const emptyTrie = keccak256(encodeRlp("0x"))
const singleLeafRoot = (value: string) =>
  keccak256(encodeRlp(["0x2080", value]))
const headerFields = [
  "parentHash",
  "sha3Uncles",
  "miner",
  "stateRoot",
  "transactionsRoot",
  "receiptsRoot",
  "logsBloom",
  "difficulty",
  "number",
  "gasLimit",
  "gasUsed",
  "timestamp",
  "extraData",
  "mixHash",
  "nonce",
  "baseFeePerGas",
  "withdrawalsRoot",
  "blobGasUsed",
  "excessBlobGas",
  "parentBeaconBlockRoot",
  "requestsHash",
]
const numericHeaderFields = new Set([
  "difficulty",
  "number",
  "gasLimit",
  "gasUsed",
  "timestamp",
  "baseFeePerGas",
  "blobGasUsed",
  "excessBlobGas",
])
export const proxyNames = [
  "Bridge",
  "NativeBTCDepositor",
  "RebateStaking",
  "RedemptionWatchtower",
  "WalletRegistry",
]

function validateChain(
  chain: Json,
  configuredGas: number | "auto",
  label: string
) {
  same(
    Object.keys(chain).sort(),
    [
      "blocks",
      "chainId",
      "code",
      "governance",
      "namedAccounts",
      "owners",
      "proxies",
      "receipts",
      "transactions",
    ],
    `${label}: chain inventory`
  )
  same(chain.chainId, "0x7a69", `${label}: chain ID`)
  same(
    [chain.blocks.length, chain.transactions.length, chain.receipts.length],
    [96, 95, 95],
    `${label}: trace lengths`
  )
  const serialized: string[] = chain.transactions.map(
    (tx: Json, index: number) => {
      const location = `${label}: transaction ${index}`
      const block = chain.blocks[index + 1]
      const receipt = chain.receipts[index]
      same(tx.type, "0x0", `${location}: unsupported transaction type`)
      const signed = Transaction.from({
        type: 0,
        chainId: BigInt(chain.chainId),
        nonce: Number(tx.nonce),
        gasPrice: BigInt(tx.gasPrice),
        gasLimit: BigInt(tx.gas),
        to: tx.to,
        value: BigInt(tx.value),
        data: tx.input,
        signature: {
          v: BigInt(tx.v),
          r: toBeHex(BigInt(tx.r), 32),
          s: toBeHex(BigInt(tx.s), 32),
        },
      })
      same(signed.hash, tx.hash, `${location}: signed hash`)
      const sender = signed.from
      check(sender !== null, `${location}: missing recovered sender`)
      same(sender.toLowerCase(), tx.from, `${location}: recovered sender`)
      same(tx.blockHash, block.hash, `${location}: block hash`)
      same(tx.blockNumber, block.number, `${location}: block number`)
      same(tx.transactionIndex, "0x0", `${location}: transaction index`)
      same(block.transactions, [tx.hash], `${location}: block transactions`)
      same(receipt.blockHash, block.hash, `${location}: receipt block hash`)
      same(
        receipt.blockNumber,
        block.number,
        `${location}: receipt block number`
      )
      same(receipt.transactionHash, tx.hash, `${location}: receipt transaction`)
      same(receipt.transactionIndex, "0x0", `${location}: receipt index`)
      same(receipt.type, tx.type, `${location}: receipt type`)
      same(receipt.from, tx.from, `${location}: receipt sender`)
      same(receipt.to, tx.to, `${location}: receipt recipient`)
      same(receipt.status, "0x1", `${location}: failed transaction`)
      same(receipt.effectiveGasPrice, tx.gasPrice, `${location}: gas price`)
      same(receipt.gasUsed, block.gasUsed, `${location}: gas used`)
      same(
        receipt.cumulativeGasUsed,
        receipt.gasUsed,
        `${location}: cumulative gas`
      )
      same(
        receipt.contractAddress,
        tx.to === null
          ? getCreateAddress({
              from: tx.from,
              nonce: Number(tx.nonce),
            }).toLowerCase()
          : null,
        `${location}: created address`
      )
      receipt.logs.forEach((log: Json, logIndex: number) => {
        same(log.blockHash, block.hash, `${location}: log block hash`)
        same(log.blockNumber, block.number, `${location}: log block number`)
        same(log.transactionHash, tx.hash, `${location}: log transaction`)
        same(log.transactionIndex, "0x0", `${location}: log transaction index`)
        same(Number(log.logIndex), logIndex, `${location}: log index`)
        same(log.removed, false, `${location}: removed log`)
      })
      same(
        singleLeafRoot(signed.serialized),
        block.transactionsRoot,
        `${location}: transaction trie root`
      )
      const encodedReceipt = encodeRlp([
        quantity(receipt.status),
        quantity(receipt.cumulativeGasUsed),
        receipt.logsBloom,
        receipt.logs.map((log: Json) => [log.address, log.topics, log.data]),
      ])
      same(
        singleLeafRoot(encodedReceipt),
        block.receiptsRoot,
        `${location}: receipt trie root`
      )
      return signed.serialized
    }
  )
  chain.blocks.forEach((block: Json, index: number) => {
    const location = `${label}: block ${index}`
    same(Number(block.number), index, `${location}: number`)
    same(block.uncles, [], `${location}: uncles`)
    same(block.withdrawals, [], `${location}: withdrawals`)
    same(block.withdrawalsRoot, emptyTrie, `${location}: withdrawal root`)
    if (index === 0) {
      same(block.transactions, [], `${location}: genesis transactions`)
      same(
        block.transactionsRoot,
        // Hardhat 2.29's genesis uses the hash of empty bytes here.
        keccak256("0x"),
        `${location}: genesis transaction root`
      )
      same(block.receiptsRoot, emptyTrie, `${location}: genesis receipt root`)
      same(block.gasUsed, "0x0", `${location}: genesis gas`)
      same(
        Number(block.timestamp),
        Date.parse("2026-09-07T00:00:00Z") / 1000,
        `${location}: initial time`
      )
    } else {
      same(
        block.parentHash,
        chain.blocks[index - 1].hash,
        `${location}: parent`
      )
      same(
        BigInt(block.timestamp),
        BigInt(chain.blocks[index - 1].timestamp) + 1n,
        `${location}: timestamp increment`
      )
    }
    const header = headerFields.map((key) =>
      numericHeaderFields.has(key) ? quantity(block[key]) : block[key]
    )
    same(keccak256(encodeRlp(header)), block.hash, `${location}: header hash`)
    const body = encodeRlp([
      header,
      index ? [decodeRlp(serialized[index - 1])] : [],
      [],
      [],
    ])
    same(
      BigInt(getBytes(body).length),
      BigInt(block.size),
      `${location}: encoded size`
    )
  })

  same(
    Object.keys(chain.proxies).sort(),
    proxyNames,
    `${label}: proxy inventory`
  )
  same(Object.keys(chain.owners).length, 22, `${label}: owner getter inventory`)
  same(
    Object.keys(chain.governance).sort(),
    [
      "Bridge.governance",
      "RandomBeacon.governance",
      "TokenStaking.governance",
      "WalletRegistry.governance",
      "WalletRegistry.walletOwner",
    ],
    `${label}: governance getter inventory`
  )
  const admin = addressFromWord(chain.proxies.Bridge.admin)
  Object.values(chain.proxies).forEach((proxy: Json) => {
    same(addressFromWord(proxy.admin), admin, `${label}: shared admin`)
    same(
      proxy.adminOwner,
      word(chain.namedAccounts.esdm),
      `${label}: admin owner`
    )
    check(
      chain.code[proxy.address.toLowerCase()] !== "0x",
      `${label}: proxy code`
    )
    check(
      chain.code[addressFromWord(proxy.implementation)] !== "0x",
      `${label}: implementation code`
    )
  })
  const created = chain.receipts
    .filter((r: Json) => r.contractAddress)
    .map((r: Json) => r.contractAddress)
    .sort()
  same(
    Object.keys(chain.code).sort(),
    created,
    `${label}: runtime code inventory`
  )
  same(created.length, 53, `${label}: creation count`)
  Object.values(chain.code).forEach((code) =>
    check(
      typeof code === "string" && /^0x(?:[a-f0-9]{2})+$/.test(code),
      `${label}: empty/invalid runtime code`
    )
  )

  const transfer = chain.transactions[41]
  same(
    [
      transfer.blockNumber,
      transfer.transactionIndex,
      transfer.nonce,
      transfer.from,
      transfer.to,
      transfer.value,
      transfer.input,
    ],
    [
      "0x2a",
      "0x0",
      "0x29",
      chain.namedAccounts.deployer.toLowerCase(),
      admin,
      "0x0",
      `0xf2fde38b${word(chain.namedAccounts.esdm).slice(2)}`,
    ],
    `${label}: allowed ownership-transfer identity`
  )
  const transferReceipt = chain.receipts[41]
  same(transferReceipt.logs.length, 1, `${label}: ownership event count`)
  same(transferReceipt.logs[0].address, admin, `${label}: ownership emitter`)
  same(
    transferReceipt.logs[0].topics,
    [
      id("OwnershipTransferred(address,address)"),
      word(chain.namedAccounts.deployer),
      word(chain.namedAccounts.esdm),
    ],
    `${label}: decoded ownership event`
  )
  const intrinsic = getBytes(transfer.input).reduce(
    (gas, byte) => gas + (byte ? 68n : 4n),
    21000n
  )
  const expectedGas =
    configuredGas === "auto"
      ? BigInt(transferReceipt.gasUsed)
      : BigInt(configuredGas) - 1000000n + intrinsic
  same(
    BigInt(transfer.gas),
    expectedGas,
    `${label}: derived ownership gas limit`
  )
}

export function compareChains(
  baseline: Json,
  candidate: Json,
  baselineGas: number
): void {
  validateChain(baseline, baselineGas, "baseline")
  validateChain(candidate, "auto", "candidate")
  const transactions = candidate.transactions.map(
    (source: Json, index: number) => {
      const tx = { ...source }
      if (index >= 41) tx.blockHash = baseline.transactions[index].blockHash
      if (index === 41) {
        check(
          tx.gas !== baseline.transactions[index].gas,
          "Expected one gas-limit change"
        )
        const fields = ["gas", "v", "r", "s", "hash"]
        fields.forEach((key) => {
          tx[key] = baseline.transactions[index][key]
        })
      }
      return tx
    }
  )
  const blocks = candidate.blocks.map((source: Json, index: number) => {
    const block = { ...source }
    if (index >= 42) block.hash = baseline.blocks[index].hash
    if (index >= 43) block.parentHash = baseline.blocks[index].parentHash
    if (index === 42) {
      const fields = ["transactions", "transactionsRoot", "size"]
      fields.forEach((key) => {
        block[key] = baseline.blocks[index][key]
      })
    }
    return block
  })
  const receipts = candidate.receipts.map((source: Json, index: number) => {
    const receipt = { ...source }
    if (index >= 41) receipt.blockHash = baseline.receipts[index].blockHash
    if (index === 41)
      receipt.transactionHash = baseline.receipts[index].transactionHash
    receipt.logs = source.logs.map((entry: Json, logIndex: number) => {
      const log = { ...entry }
      if (index >= 41)
        log.blockHash = baseline.receipts[index].logs[logIndex].blockHash
      if (index === 41)
        log.transactionHash =
          baseline.receipts[index].logs[logIndex].transactionHash
      return log
    })
    return receipt
  })
  // Replace only already-verified derived fields, in memory. Raw files survive.
  same(
    { ...candidate, transactions, blocks, receipts },
    baseline,
    "Unlisted chain/code/ownership difference"
  )
}
