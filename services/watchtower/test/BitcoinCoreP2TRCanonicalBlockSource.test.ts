import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Block, Transaction } from "bitcoinjs-lib"
import {
  BitcoinCoreP2TRCanonicalBlockSource,
  HttpP2TRBitcoinCoreRpc,
} from "../src/BitcoinCoreP2TRCanonicalBlockSource.js"
import type { P2TRBitcoinCoreRpc } from "../src/BitcoinCoreP2TRCanonicalBlockSource.js"

const ZERO_HASH = "00".repeat(32)

describe("BitcoinCoreP2TRCanonicalBlockSource", () => {
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

const bitcoinBlockFixture = (reportedPrevoutValueSats: number) => {
  const previous = new Transaction()
  previous.version = 2
  previous.addInput(Buffer.alloc(32), 0xffffffff, 0xffffffff, Buffer.from([1]))
  previous.addOutput(Buffer.from("51", "hex"), 125_000_000)

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
              scriptPubKey: { hex: "51" },
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
  Buffer.from(transaction.getHash(true)).reverse().toString("hex")
