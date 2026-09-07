import assert from "assert"

import { EthereumAddress, EthereumBridge } from "@keep-network/tbtc-v2.ts"

import {
  RedemptionChain,
  redemptionMonitoringABI as abi,
} from "../src/redemption-chain"

import { test } from "./test-runner"
import { redemptionRequest } from "./redemption-fixtures"

import type { providers } from "ethers"
import type { Bridge } from "@keep-network/tbtc-v2.ts"

const address = `0x${"aa".repeat(20)}`
const wallet = `0x${"11".repeat(20)}`
const script = `0014${"33".repeat(20)}`
const bridge: Pick<
  Bridge,
  "getChainIdentifier" | "getRedemptionRequestedEvents"
> = {
  getChainIdentifier: () => EthereumAddress.from(address),
  getRedemptionRequestedEvents: async () => [],
}

function log(name: string, args: unknown[], block: number): providers.Log {
  const encoded = abi.encodeEventLog(abi.getEvent(name), args)
  return {
    ...encoded,
    blockNumber: block,
    blockHash: `0x${"22".repeat(32)}`,
    transactionHash: `0x${"44".repeat(32)}`,
    transactionIndex: 0,
    logIndex: 0,
    removed: false,
    address,
  }
}

function provider(): Pick<providers.Provider, "getLogs" | "call" | "getBlock"> {
  return {
    getLogs: async () => [],
    call: async () => {
      throw new Error("unexpected eth_call")
    },
    getBlock: async () => {
      throw new Error("unexpected block read")
    },
  }
}

test("lifecycle adapter decodes real ABI logs and queries all indexed wallets", async () => {
  const rpc = provider()
  rpc.getLogs = async (filter) => {
    assert.strictEqual(filter.address, address)
    assert.strictEqual(filter.fromBlock, 100)
    assert.strictEqual(filter.toBlock, 200)
    assert.strictEqual(filter.topics?.length, 1)
    if (filter.topics?.[0] === abi.getEventTopic("RedemptionsCompleted")) {
      return [
        log("RedemptionsCompleted", [wallet, `0x01${"00".repeat(30)}ab`], 123),
      ]
    }
    return [log("RedemptionTimedOut", [wallet, `0x16${script}`], 124)]
  }
  const chain = new RedemptionChain(bridge, rpc)
  const [proof] = await chain.completed(100, 200)
  assert.strictEqual(
    proof.redemptionTxHash.toString(),
    `ab${"00".repeat(30)}01`
  )
  assert.strictEqual(proof.walletPublicKeyHash.toPrefixedString(), wallet)
  assert.strictEqual(proof.blockNumber, 123)
  const [report] = await chain.timedOut(100, 200)
  assert.strictEqual(report.redeemerOutputScript.toString(), script)
  assert.strictEqual(report.blockNumber, 124)
})

test("lifecycle adapter reads the configured timeout and current request at an exact historical block", async () => {
  const rpc = provider()
  const request = redemptionRequest()
  const observedBlocks: unknown[] = []
  rpc.call = async (transaction, block) => {
    assert.strictEqual(transaction.to, address)
    observedBlocks.push(block)
    const data = await transaction.data
    const parsed = abi.parseTransaction({ data: String(data) })
    if (parsed.name === "redemptionParameters") {
      return abi.encodeFunctionResult(
        parsed.name,
        [1000, 2000, 3000, 4000, 172800, 5000, 100]
      )
    }
    assert.strictEqual(
      parsed.args.redemptionKey.toHexString(),
      EthereumBridge.buildRedemptionKey(
        request.walletPublicKeyHash,
        request.redeemerOutputScript
      )
    )
    return abi.encodeFunctionResult(parsed.name, [
      [address, 10000000, 1000, 10000, 1234],
    ])
  }
  const chain = new RedemptionChain(bridge, rpc)
  assert.strictEqual(await chain.timeout(0), 172800)
  assert.strictEqual(await chain.pendingRequestedAt(request, 200), 1234)
  assert.deepStrictEqual(observedBlocks, [0, 200])
})

test("lifecycle log reads and SDK request reads are bounded and preserve inclusive endpoints", async () => {
  const ranges: unknown[] = []
  const rpc = provider()
  rpc.getLogs = async (filter) => {
    ranges.push([filter.fromBlock, filter.toBlock])
    return []
  }
  const requestBridge = {
    ...bridge,
    getRedemptionRequestedEvents: async (options?: {
      fromBlock?: number
      toBlock?: number | string
    }) => {
      ranges.push([options?.fromBlock, options?.toBlock])
      return []
    },
  }
  const chain = new RedemptionChain(requestBridge, rpc)
  await chain.completed(100, 10100)
  await chain.requested(100, 10100)
  assert.deepStrictEqual(ranges, [
    [100, 5099],
    [5100, 10099],
    [10100, 10100],
    [100, 5099],
    [5100, 10099],
    [10100, 10100],
  ])
})

test("lifecycle adapter propagates log and historical state failures", async () => {
  const rpc = provider()
  rpc.getLogs = async () => {
    throw new Error("logs unavailable")
  }
  const chain = new RedemptionChain(bridge, rpc)
  await assert.rejects(() => chain.completed(1, 2), /logs unavailable/)
  await assert.rejects(() => chain.timeout(2), /unexpected eth_call/)
})
