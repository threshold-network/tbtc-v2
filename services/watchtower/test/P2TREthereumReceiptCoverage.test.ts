import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  computeP2TREthereumRpcBlockHash,
  serializeP2TREthereumRpcReceipt,
} from "../src/EthereumCanonicalHeaderProof.js"
import {
  computeP2TRCanonicalEthereumBlockCoverage,
  type P2TRCanonicalEthereumReceipt,
} from "../src/P2TRCanonicalEthereumJournal.js"
import {
  accumulateP2TRRequiredEventHistoryBlock,
  initialP2TRRequiredEventHistoryRoot,
} from "../src/P2TRProductionActivation.js"
import {
  canonicalReceiptCoverageFixture,
  hash,
} from "./P2TREthereumCanonicalFixture.js"

describe("Ethereum receipt-complete coverage commitment", () => {
  it("reconstructs canonical trie roots deterministically", async () => {
    const fixture = await canonicalReceiptCoverageFixture()
    const left = await computeP2TRCanonicalEthereumBlockCoverage(
      structuredClone(fixture.block),
      structuredClone(fixture.receipts),
      [{ eventID: hash(1) }]
    )
    const right = await computeP2TRCanonicalEthereumBlockCoverage(
      structuredClone(fixture.block),
      structuredClone(fixture.receipts),
      [{ eventID: hash(1) }]
    )
    assert.deepEqual(left, right)
    assert.equal(left.transactionsRoot, fixture.block.transactionsRoot)
    assert.equal(left.receiptsRoot, fixture.block.receiptsRoot)

    const state = accumulateP2TRRequiredEventHistoryBlock(
      initialP2TRRequiredEventHistoryRoot(1, {
        blockNumber: 9,
        blockHash: hash(9),
      }),
      fixture.block,
      left,
      [{ eventID: hash(1) }]
    )
    assert.deepEqual(state.counters, {
      blocks: 1,
      transactions: 2,
      receipts: 2,
      logs: 3,
      requiredEvents: 1,
    })
  })

  it("rejects omitted or reordered receipts and transactions", async () => {
    const { block, receipts } = await canonicalReceiptCoverageFixture()
    await assert.rejects(
      computeP2TRCanonicalEthereumBlockCoverage(
        block,
        receipts.slice(0, 1),
        []
      ),
      /receipt coverage is incomplete/
    )
    await assert.rejects(
      computeP2TRCanonicalEthereumBlockCoverage(
        block,
        [...receipts].reverse(),
        []
      ),
      /inconsistent with its block/
    )
    await assert.rejects(
      computeP2TRCanonicalEthereumBlockCoverage(
        {
          ...block,
          serializedTransactions: block.serializedTransactions.slice(1),
        },
        receipts,
        []
      ),
      /serialized transaction coverage is inconsistent/
    )
  })

  it("rejects an omitted, reordered, or impossible failed-receipt log", async () => {
    const { block, receipts } = await canonicalReceiptCoverageFixture()
    const omitted = structuredClone(receipts)
    omitted[0].logs = [omitted[0].logs[0]]
    omitted[1].logs = [{ ...omitted[1].logs[0], logIndex: 1 }]
    await assert.rejects(
      computeP2TRCanonicalEthereumBlockCoverage(block, omitted, []),
      /trie root mismatch/
    )

    const reordered = structuredClone(receipts)
    reordered[0].logs = [...reordered[0].logs].reverse()
    await assert.rejects(
      computeP2TRCanonicalEthereumBlockCoverage(block, reordered, []),
      /log coverage is not contiguous/
    )

    const failed = structuredClone(receipts)
    failed[0] = { ...failed[0], status: 0 }
    await assert.rejects(
      computeP2TRCanonicalEthereumBlockCoverage(block, failed, []),
      /inconsistent with its block/
    )
  })

  it("fails closed on unsupported envelopes and mutated fork header fields", async () => {
    const { block, receipts } = await canonicalReceiptCoverageFixture()
    const unsupported: P2TRCanonicalEthereumReceipt[] =
      structuredClone(receipts)
    unsupported[0].type = 5
    await assert.rejects(
      computeP2TRCanonicalEthereumBlockCoverage(block, unsupported, []),
      /receipt type is unsupported/
    )

    await assert.rejects(
      computeP2TRCanonicalEthereumBlockCoverage(
        {
          ...block,
          canonicalHeader: { ...block.canonicalHeader, baseFeePerGas: "0x8" },
        },
        receipts,
        []
      ),
      /header hash or committed roots are inconsistent/
    )

    assert.throws(
      () =>
        computeP2TREthereumRpcBlockHash({
          ...block.canonicalHeader,
          baseFeePerGas: undefined,
          withdrawalsRoot: hash(700),
        }),
      /impossible fork header field combination/
    )
    assert.throws(
      () =>
        computeP2TREthereumRpcBlockHash({
          ...block.canonicalHeader,
          withdrawalsRoot: hash(700),
          blobGasUsed: "0x0",
        }),
      /impossible fork header field combination/
    )
    assert.throws(
      () =>
        computeP2TREthereumRpcBlockHash({
          ...block.canonicalHeader,
          requestsHash: hash(701),
        }),
      /impossible fork header field combination/
    )
    assert.throws(
      () => serializeP2TREthereumRpcReceipt({ ...receipts[0], status: 2 }),
      /status must be zero or one/
    )
    assert.throws(
      () =>
        serializeP2TREthereumRpcReceipt({
          ...receipts[0],
          root: hash(702),
        }),
      /status and no state root/
    )
  })
})
