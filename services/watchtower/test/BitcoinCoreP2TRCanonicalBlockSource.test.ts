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

  it("cross-checks verbosity-3 prevouts against raw txindex bytes", async () => {
    const fixture = bitcoinBlockFixture(124_999_999)
    const source = new BitcoinCoreP2TRCanonicalBlockSource(
      fixture.rpc,
      sourceOptions()
    )

    await assert.rejects(
      source.getBlock(1),
      /verbosity-3 prevout does not match raw transaction/
    )
  })

  it("exposes raw-transaction-authenticated prevouts after all cross-checks", async () => {
    const fixture = bitcoinBlockFixture(125_000_000)
    const source = new BitcoinCoreP2TRCanonicalBlockSource(
      fixture.rpc,
      sourceOptions()
    )

    const block = await source.getBlock(1)

    assert.equal(
      block.transactions[1].inputs[0].authenticatedPrevout?.valueSats,
      125_000_000
    )
    assert.equal(
      block.transactions[1].inputs[0].authenticatedPrevout?.scriptPubKey,
      "51"
    )
  })

  it("accepts an empty consensus-valid prevout script authenticated by raw bytes", async () => {
    const fixture = bitcoinBlockFixture(125_000_000, "")
    const source = new BitcoinCoreP2TRCanonicalBlockSource(
      fixture.rpc,
      sourceOptions()
    )

    const block = await source.getBlock(1)

    assert.equal(
      block.transactions[1].inputs[0].authenticatedPrevout?.scriptPubKey,
      ""
    )
  })

  it("continues to reject empty raw block and transaction hex", async () => {
    const fixture = bitcoinBlockFixture(125_000_000)
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

  it("rejects operator transport bounds below the verbosity-3 production floor", () => {
    assert.throws(
      () =>
        new HttpP2TRBitcoinCoreRpc({
          url: "http://127.0.0.1:8332",
          username: "rpc-user",
          password: "rpc-password",
          maxResponseBytes: 255 * 1024 * 1024,
        }),
      /at least the 268435456-byte transport bound/
    )
  })
})

const sourceOptions = () => ({
  trustDomainID: "bitcoin-core-primary",
  network: "regtest" as const,
  expectedGenesisHash: "11".repeat(32),
})

const bitcoinBlockFixture = (
  reportedPrevoutValueSats: number,
  previousScriptPubKey = "51"
) => {
  const previous = new Transaction()
  previous.version = 2
  previous.addInput(Buffer.alloc(32), 0xffffffff, 0xffffffff, Buffer.from([1]))
  previous.addOutput(Buffer.from(previousScriptPubKey, "hex"), 125_000_000)

  const coinbase = new Transaction()
  coinbase.version = 2
  coinbase.addInput(Buffer.alloc(32), 0xffffffff, 0xffffffff, Buffer.from([2]))
  coinbase.addOutput(Buffer.from("51", "hex"), 5_000_000_000)

  const spend = new Transaction()
  spend.version = 2
  spend.addInput(previous.getHash(), 0)
  spend.addOutput(Buffer.from("51", "hex"), 124_999_000)

  const block = mineRegtestBlock([coinbase, spend])
  const blockHash = block.getId()
  const verboseBlock = {
    hash: blockHash,
    height: 1,
    previousblockhash: ZERO_HASH,
    tx: [
      {
        txid: coinbase.getId(),
        hash: witnessTransactionID(coinbase),
        vin: [{ coinbase: "02" }],
      },
      {
        txid: spend.getId(),
        hash: witnessTransactionID(spend),
        vin: [
          {
            txid: previous.getId(),
            vout: 0,
            prevout: {
              value: reportedPrevoutValueSats / 100_000_000,
              scriptPubKey: { hex: previousScriptPubKey },
            },
          },
        ],
      },
    ],
  }
  const rpc: P2TRBitcoinCoreRpc = {
    async call<T>(method: string, parameters: readonly unknown[] = []) {
      if (method === "getblockhash" && parameters[0] === 1) {
        return blockHash as T
      }
      if (method === "getblock" && parameters[1] === 0) {
        return block.toHex() as T
      }
      if (method === "getblock" && parameters[1] === 3) {
        return verboseBlock as T
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
  return { rpc }
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

const mineRegtestBlock = (transactions: Transaction[]): Block => {
  const block = new Block()
  block.version = 4
  block.prevHash = Buffer.alloc(32)
  block.merkleRoot = Block.calculateMerkleRoot(transactions)
  block.timestamp = 1_700_000_000
  block.bits = 0x207fffff
  block.transactions = transactions
  for (let nonce = 0; nonce <= 0xffffffff; nonce++) {
    block.nonce = nonce
    if (block.checkProofOfWork()) return block
  }
  throw new Error("Could not mine deterministic regtest fixture")
}

const witnessTransactionID = (transaction: Transaction): string =>
  createHash("sha256")
    .update(createHash("sha256").update(transaction.toBuffer()).digest())
    .digest()
    .reverse()
    .toString("hex")
