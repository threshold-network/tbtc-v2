import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  JsonRpcP2TRCanonicalEthereumProvider,
  type P2TREthereumJsonRpc,
} from "../src/HttpP2TREthereumJsonRpc.js"
import {
  canonicalReceiptCoverageFixture,
  hash,
} from "./P2TREthereumCanonicalFixture.js"

describe("Ethereum JSON-RPC canonical block adapter", () => {
  it("requires full transactions and preserves receipt consensus fields", async () => {
    const fixture = await canonicalReceiptCoverageFixture()
    const rpc = fixtureRpc(fixture)
    const provider = new JsonRpcP2TRCanonicalEthereumProvider(rpc, {
      trustDomainID: "ethereum-a",
    })

    const block = await provider.getBlock(fixture.block.blockNumber)
    assert.deepEqual(block, fixture.block)
    assert.deepEqual(rpc.blockParameters, ["0xa", true])
    const receipt = await provider.getTransactionReceipt(
      fixture.block.transactionHashes[0]
    )
    assert.deepEqual(receipt, fixture.receipts[0])
  })

  it("rejects a transaction body that does not hash to the header enumeration", async () => {
    const fixture = await canonicalReceiptCoverageFixture()
    const rpc = fixtureRpc(fixture, {
      transactions: [
        { ...fixture.rpcTransactions[0], input: "0x01" },
        fixture.rpcTransactions[1],
      ],
    })
    const provider = new JsonRpcP2TRCanonicalEthereumProvider(rpc, {
      trustDomainID: "ethereum-a",
    })
    await assert.rejects(
      provider.getBlock(fixture.block.blockNumber),
      /transaction 0 hash is inconsistent/
    )
  })

  it("rejects header fields that do not reconstruct the returned block hash", async () => {
    const fixture = await canonicalReceiptCoverageFixture()
    const rpc = fixtureRpc(fixture, { header: { receiptsRoot: hash(999) } })
    const provider = new JsonRpcP2TRCanonicalEthereumProvider(rpc, {
      trustDomainID: "ethereum-a",
    })
    await assert.rejects(
      provider.getBlock(fixture.block.blockNumber),
      /invalid header hash/
    )
  })
})

type Fixture = Awaited<ReturnType<typeof canonicalReceiptCoverageFixture>>

function fixtureRpc(
  fixture: Fixture,
  overrides: {
    transactions?: ReadonlyArray<Readonly<Record<string, unknown>>>
    header?: Readonly<Record<string, unknown>>
  } = {}
): P2TREthereumJsonRpc & { blockParameters?: readonly unknown[] } {
  const rpc: P2TREthereumJsonRpc & { blockParameters?: readonly unknown[] } = {
    endpointFingerprint: hash(800),
    call: async <Result>(
      method: string,
      parameters: readonly unknown[] = []
    ) => {
      if (method === "eth_getBlockByNumber") {
        rpc.blockParameters = parameters
        return {
          ...fixture.block.canonicalHeader,
          ...overrides.header,
          hash: fixture.block.blockHash,
          transactions: overrides.transactions ?? fixture.rpcTransactions,
        } as Result
      }
      if (method === "eth_getTransactionReceipt") {
        const transactionHash = String(parameters[0])
        const receipt = fixture.receipts.find(
          (entry) => entry.transactionHash === transactionHash
        )
        if (receipt === undefined) return null as Result
        return {
          ...receipt,
          type: quantity(receipt.type),
          status: quantity(receipt.status),
          blockNumber: quantity(receipt.blockNumber),
          transactionIndex: quantity(receipt.transactionIndex),
          logs: receipt.logs.map((log) => ({
            ...log,
            blockNumber: quantity(log.blockNumber),
            transactionIndex: quantity(log.transactionIndex),
            logIndex: quantity(log.logIndex),
          })),
        } as Result
      }
      throw new Error(`unexpected RPC method ${method}`)
    },
  }
  return rpc
}

function quantity(value: number): string {
  return `0x${value.toString(16)}`
}
