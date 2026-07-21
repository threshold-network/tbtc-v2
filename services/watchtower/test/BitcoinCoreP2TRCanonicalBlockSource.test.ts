import assert from "node:assert/strict"
import { createHash } from "node:crypto"
import { describe, it } from "node:test"
import { Block, Transaction } from "bitcoinjs-lib"
import {
  BitcoinCoreP2TRCanonicalBlockSource,
  HttpP2TRBitcoinCoreRpc,
} from "../src/BitcoinCoreP2TRCanonicalBlockSource.js"
import type { P2TRBitcoinCoreRpc } from "../src/BitcoinCoreP2TRCanonicalBlockSource.js"

const ZERO_HASH = "00".repeat(32)
const BITCOIN_MAINNET_GENESIS_HASH =
  "000000000019d6689c085ae165831e934ff763ae46a2a6c172b3f1b60a8ce26f"
const BITCOIN_MAINNET_GENESIS_COINBASE_TXID =
  "4a5e1e4baab89f3a32518a88c31bc87f618f76673e2cc77ab2127b7afdeda33b"

describe("BitcoinCoreP2TRCanonicalBlockSource", () => {
  it("matches Bitcoin Core's real genesis coinbase wtxid instead of the BIP141 sentinel", async () => {
    const source = new BitcoinCoreP2TRCanonicalBlockSource(
      realBitcoinCoreGenesisFixture(),
      {
        trustDomainID: "bitcoin-core-mainnet-fixture",
        network: "main",
        expectedGenesisHash: BITCOIN_MAINNET_GENESIS_HASH,
      }
    )

    const block = await source.getBlock(0)

    assert.equal(block.hash, BITCOIN_MAINNET_GENESIS_HASH)
    assert.equal(
      block.transactions[0].txid,
      BITCOIN_MAINNET_GENESIS_COINBASE_TXID
    )
    assert.equal(
      block.transactions[0].wtxid,
      BITCOIN_MAINNET_GENESIS_COINBASE_TXID
    )
    assert.notEqual(block.transactions[0].wtxid, ZERO_HASH)
  })

  it("loads only the raw block and leaves prevout resolution to the canonical journal", async () => {
    const fixture = bitcoinBlockFixture()
    const source = new BitcoinCoreP2TRCanonicalBlockSource(
      fixture.rpc,
      sourceOptions()
    )

    const block = await source.getBlock(1)

    assert.equal(
      block.transactions[1].inputs[0].authenticatedPrevout,
      undefined
    )
    assert.equal(block.rawBlockHex, fixture.rawBlockHex)
    assert.equal(block.header80Hex, fixture.rawBlockHex.slice(0, 160))
    assert.equal(block.header80Hex.length, 160)
    assert.deepEqual(fixture.calls, [
      { method: "getblockhash", parameters: [1] },
      { method: "getblock", parameters: [fixture.blockHash, 0] },
    ])
  })

  it("preserves an empty consensus-valid output script from raw block bytes", async () => {
    const fixture = bitcoinBlockFixture("")
    const source = new BitcoinCoreP2TRCanonicalBlockSource(
      fixture.rpc,
      sourceOptions()
    )

    const block = await source.getBlock(1)

    assert.equal(block.transactions[1].outputs[0].scriptPubKey, "")
  })

  it("handles a large raw-block script without requesting an expanded block", async () => {
    const fixture = bitcoinBlockFixture("51".repeat(10_000))
    const source = new BitcoinCoreP2TRCanonicalBlockSource(
      fixture.rpc,
      sourceOptions()
    )

    const block = await source.getBlock(1)

    assert.equal(block.transactions[1].outputs[0].scriptPubKey.length, 20_000)
    assert.equal(
      fixture.calls.some(
        ({ method, parameters }) => method === "getblock" && parameters[1] !== 0
      ),
      false
    )
    assert.equal(
      fixture.calls.some(({ method }) => method === "getrawtransaction"),
      false
    )
  })

  it("rejects duplicate-last and duplicate-pair merkle mutations", async () => {
    const canonicalLast = [
      coinbaseTransaction(1),
      spendTransaction(1),
      spendTransaction(2),
    ]
    const duplicateLast = mineRegtestBlock(
      [...canonicalLast, canonicalLast[canonicalLast.length - 1]],
      canonicalLast
    )
    await assert.rejects(
      new BitcoinCoreP2TRCanonicalBlockSource(
        rawBlockRpc(duplicateLast),
        sourceOptions()
      ).getBlock(1),
      /mutated transaction merkle tree/
    )

    const canonicalPair = [
      coinbaseTransaction(2),
      spendTransaction(3),
      spendTransaction(4),
      spendTransaction(5),
      spendTransaction(6),
      spendTransaction(7),
    ]
    const duplicatePair = mineRegtestBlock(
      [...canonicalPair, canonicalPair[4], canonicalPair[5]],
      canonicalPair
    )
    await assert.rejects(
      new BitcoinCoreP2TRCanonicalBlockSource(
        rawBlockRpc(duplicatePair),
        sourceOptions()
      ).getBlock(1),
      /mutated transaction merkle tree/
    )
  })

  it("requires exactly one first coinbase and structurally valid transactions", async () => {
    const missingCoinbase = mineRegtestBlock([
      spendTransaction(8),
      spendTransaction(9),
    ])
    await assert.rejects(
      new BitcoinCoreP2TRCanonicalBlockSource(
        rawBlockRpc(missingCoinbase),
        sourceOptions()
      ).getBlock(1),
      /does not begin with coinbase/
    )

    const extraCoinbase = mineRegtestBlock([
      coinbaseTransaction(3),
      coinbaseTransaction(4),
    ])
    await assert.rejects(
      new BitcoinCoreP2TRCanonicalBlockSource(
        rawBlockRpc(extraCoinbase),
        sourceOptions()
      ).getBlock(1),
      /multiple coinbase transactions/
    )

    const duplicateInput = spendTransaction(10)
    duplicateInput.addInput(
      Buffer.from(duplicateInput.ins[0].hash),
      duplicateInput.ins[0].index
    )
    const duplicateInputs = mineRegtestBlock([
      coinbaseTransaction(5),
      duplicateInput,
    ])
    await assert.rejects(
      new BitcoinCoreP2TRCanonicalBlockSource(
        rawBlockRpc(duplicateInputs),
        sourceOptions()
      ).getBlock(1),
      /duplicate inputs/
    )
  })

  it("continues to reject empty raw block and transaction hex", async () => {
    const fixture = bitcoinBlockFixture()
    const emptyBlockRpc: P2TRBitcoinCoreRpc = {
      call: async <T>(method: string, parameters: readonly unknown[] = []) => {
        if (method === "getblock" && parameters[1] === 0) return "" as T
        return fixture.rpc.call<T>(method, parameters)
      },
    }
    await assert.rejects(
      new BitcoinCoreP2TRCanonicalBlockSource(
        emptyBlockRpc,
        sourceOptions()
      ).getBlock(1),
      /must be non-empty, even-length hex/
    )

    const emptyTransactionRpc: P2TRBitcoinCoreRpc = {
      call: async <T>(method: string) => {
        if (method === "getrawtransaction") return "" as T
        throw new Error(`Unexpected RPC ${method}`)
      },
    }
    await assert.rejects(
      new BitcoinCoreP2TRCanonicalBlockSource(
        emptyTransactionRpc,
        sourceOptions()
      ).getRawTransaction("11".repeat(32)),
      /must be non-empty, even-length hex/
    )
  })

  it("rejects operator transport bounds below the raw-block production floor", () => {
    assert.throws(
      () =>
        new HttpP2TRBitcoinCoreRpc({
          url: "http://127.0.0.1:8332",
          username: "rpc-user",
          password: "rpc-password",
          maxResponseBytes: 16 * 1024 * 1024 - 1,
        }),
      /at least the 16777216-byte transport bound/
    )
  })
})

const sourceOptions = () => ({
  trustDomainID: "bitcoin-core-primary",
  network: "regtest" as const,
  expectedGenesisHash: "11".repeat(32),
})

const bitcoinBlockFixture = (spendScriptPubKey = "51") => {
  const previous = new Transaction()
  previous.version = 2
  previous.addInput(Buffer.alloc(32), 0xffffffff, 0xffffffff, Buffer.from([1]))
  previous.addOutput(Buffer.from("51", "hex"), 125_000_000)

  const coinbase = new Transaction()
  coinbase.version = 2
  coinbase.addInput(
    Buffer.alloc(32),
    0xffffffff,
    0xffffffff,
    Buffer.from([2, 0])
  )
  coinbase.addOutput(Buffer.from("51", "hex"), 5_000_000_000)

  const spend = new Transaction()
  spend.version = 2
  spend.addInput(previous.getHash(), 0)
  spend.addOutput(Buffer.from(spendScriptPubKey, "hex"), 124_999_000)

  const block = mineRegtestBlock([coinbase, spend])
  const blockHash = block.getId()
  const calls: Array<{ method: string; parameters: readonly unknown[] }> = []
  const rpc: P2TRBitcoinCoreRpc = {
    async call<T>(method: string, parameters: readonly unknown[] = []) {
      calls.push({ method, parameters })
      if (method === "getblockhash" && parameters[0] === 1) {
        return blockHash as T
      }
      if (method === "getblockhash" && parameters[0] === 0) {
        return ZERO_HASH as T
      }
      if (method === "getblock" && parameters[1] === 0) {
        return block.toHex() as T
      }
      if (
        method === "getrawtransaction" &&
        parameters[0] === previous.getId()
      ) {
        return previous.toHex() as T
      }
      throw new Error(`Unexpected RPC ${method} ${JSON.stringify(parameters)}`)
    },
  }
  return { rpc, calls, blockHash, rawBlockHex: block.toHex() }
}

/**
 * Bitcoin Core 26 `getblock 0 0/3` fixture. Keeping the raw block and Core's
 * independently reported `hash` literal prevents bitcoinjs-lib's coinbase
 * witness-merkle sentinel from becoming the expected value in this test.
 */
const realBitcoinCoreGenesisFixture = (): P2TRBitcoinCoreRpc => {
  const rawBlock =
    "01000000" +
    ZERO_HASH +
    "3ba3edfd7a7b12b27ac72c3e67768f617fc81bc3888a51323a9fb8aa4b1e5e4a" +
    "29ab5f49ffff001d1dac2b7c01" +
    "0100000001" +
    ZERO_HASH +
    "ffffffff4d" +
    "04ffff001d0104455468652054696d65732030332f4a616e2f32303039204368616e63656c6c6f72206f6e206272696e6b206f66207365636f6e64206261696c6f757420666f722062616e6b73" +
    "ffffffff01" +
    "00f2052a01000000" +
    "43" +
    "4104678afdb0fe5548271967f1a67130b7105cd6a828e03909a67962e0ea1f61deb649f6bc3f4cef38c4f35504e51ec112de5c384df7ba0b8d578a4c702b6bf11d5fac" +
    "00000000"
  return {
    async call<T>(method: string, parameters: readonly unknown[] = []) {
      if (method === "getblockhash" && parameters[0] === 0) {
        return BITCOIN_MAINNET_GENESIS_HASH as T
      }
      if (method === "getblock" && parameters[1] === 0) return rawBlock as T
      if (method === "getblock" && parameters[1] === 3) {
        return {
          hash: BITCOIN_MAINNET_GENESIS_HASH,
          height: 0,
          tx: [
            {
              txid: BITCOIN_MAINNET_GENESIS_COINBASE_TXID,
              hash: BITCOIN_MAINNET_GENESIS_COINBASE_TXID,
              vin: [
                {
                  coinbase:
                    "04ffff001d0104455468652054696d65732030332f4a616e2f32303039204368616e63656c6c6f72206f6e206272696e6b206f66207365636f6e64206261696c6f757420666f722062616e6b73",
                },
              ],
            },
          ],
        } as T
      }
      throw new Error(`Unexpected RPC ${method} ${JSON.stringify(parameters)}`)
    },
  }
}

const mineRegtestBlock = (
  transactions: Transaction[],
  merkleTransactions = transactions
): Block => {
  const block = new Block()
  block.version = 4
  block.prevHash = Buffer.alloc(32)
  block.merkleRoot = Block.calculateMerkleRoot(merkleTransactions)
  block.timestamp = 1_700_000_000
  block.bits = 0x207fffff
  block.transactions = transactions
  for (let nonce = 0; nonce <= 0xffffffff; nonce++) {
    block.nonce = nonce
    if (block.checkProofOfWork()) return block
  }
  throw new Error("Could not mine deterministic regtest fixture")
}

const coinbaseTransaction = (tag: number): Transaction => {
  const transaction = new Transaction()
  transaction.version = 2
  transaction.addInput(
    Buffer.alloc(32),
    0xffffffff,
    0xffffffff,
    Buffer.from([2, tag & 0xff])
  )
  transaction.addOutput(Buffer.from("51", "hex"), 5_000_000_000 - tag)
  return transaction
}

const spendTransaction = (tag: number): Transaction => {
  const transaction = new Transaction()
  transaction.version = 2
  transaction.addInput(Buffer.alloc(32, tag & 0xff), tag)
  transaction.addOutput(Buffer.from("51", "hex"), 10_000 + tag)
  return transaction
}

const rawBlockRpc = (block: Block): P2TRBitcoinCoreRpc => ({
  async call<T>(method: string, parameters: readonly unknown[] = []) {
    if (method === "getblockhash" && parameters[0] === 1) {
      return block.getId() as T
    }
    if (method === "getblock" && parameters[1] === 0) {
      return block.toHex() as T
    }
    throw new Error(`Unexpected RPC ${method} ${JSON.stringify(parameters)}`)
  },
})

const witnessTransactionID = (transaction: Transaction): string =>
  createHash("sha256")
    .update(createHash("sha256").update(transaction.toBuffer()).digest())
    .digest()
    .reverse()
    .toString("hex")
