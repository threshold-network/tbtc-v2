import assert from "node:assert/strict"
import { describe, it } from "node:test"
import { Transaction } from "bitcoinjs-lib"
import {
  P2TR_KEY_PATH_SIGHASH_TYPES,
  P2TR_SIGHASH_ANYONECANPAY_SINGLE,
  P2TR_SIGHASH_DEFAULT,
  P2TR_SIGHASH_SINGLE,
  P2TRWitnessError,
  calculateP2TRKeyPathSighash,
  classifyP2TRWitness,
  computeP2TRKeyPathSharedCommitments,
  displayTxidFromWireHash,
  encodeBitcoinCompactSize,
  parseP2TRKeyPathSignature,
  serializeBitcoinOutpointFromDisplayTxid,
} from "../src/P2TRCompleteV2BIP341.js"
import type {
  P2TRBIP341Prevout,
  P2TRKeyPathSighashType,
} from "../src/P2TRCompleteV2BIP341.js"

const FULL_SIGHASH_TRANSACTION_HEX =
  "020000000311111111111111111111111111111111111111111111111111111111111111110000000000fdffffff22222222222222222222222222222222222222222222222222222222222222220200000000ffffffff33333333333333333333333333333333333333333333333333333333333333330100000000feffffff030027b9290000000022512044444444444444444444444444444444444444444444444444444444444444448055c82000000000225120555555555555555555555555555555555555555555555555555555555555555500389c1c00000000225120666666666666666666666666666666666666666666666666666666666666666620a10700"
const WALLET_SCRIPT =
  "5120f9502d540ca7d5ab09ea89e83889fa4bcd0b27f7eec5752f4fa07b1b19160f3b"

const FULL_SIGHASH_PREVOUTS: readonly P2TRBIP341Prevout[] = [
  {
    txid: "11".repeat(32),
    vout: 0,
    valueSats: 600_000_000,
    scriptPubKey: Buffer.from(WALLET_SCRIPT, "hex"),
  },
  {
    txid: "22".repeat(32),
    vout: 2,
    valueSats: 900_000_000,
    scriptPubKey: Buffer.from(WALLET_SCRIPT, "hex"),
  },
  {
    txid: "33".repeat(32),
    vout: 1,
    valueSats: 250_000_000,
    scriptPubKey: Buffer.from(WALLET_SCRIPT, "hex"),
  },
]

// Published stack vectors from p2tr-signature-fraud-full-sighash-v0.json.
const FULL_SIGHASH_CASES: readonly {
  id: string
  inputIndex: number
  hashType: P2TRKeyPathSighashType
  annex?: string
  expected: string
}[] = [
  {
    id: "default",
    inputIndex: 1,
    hashType: 0x00,
    expected: "edc0355e9a341f61fa9312ea99edc9e91501c3aeb7f5f25adb866aecbabec315",
  },
  {
    id: "all",
    inputIndex: 1,
    hashType: 0x01,
    expected: "ff879fb0ed81ddc6830f4eef5a7d4d782c324a31daa814367bd66b4f0df5f23c",
  },
  {
    id: "none",
    inputIndex: 0,
    hashType: 0x02,
    expected: "9af57a004023ccb1ec9e4a4d647b30f11b06702753fca9a602772203fb6c0051",
  },
  {
    id: "single",
    inputIndex: 2,
    hashType: 0x03,
    expected: "f6e494ec97743fe0d1d41fd61f75e0072a5f8f743d5952c5a0bdb623f0312fd0",
  },
  {
    id: "anyonecanpay-all",
    inputIndex: 0,
    hashType: 0x81,
    expected: "4ed2911002e1f12bb88ef1d370d2e31f83cc41858e6321efeba111ba8054f658",
  },
  {
    id: "anyonecanpay-none",
    inputIndex: 2,
    hashType: 0x82,
    expected: "4d5a3c5d133bf4dd3b96b0cda7389551079f8be9a2e1dc44a7f51ed4967f6676",
  },
  {
    id: "anyonecanpay-single",
    inputIndex: 1,
    hashType: 0x83,
    expected: "788c5203ce52a9ab009e8a1a99898b03000d24d7a15572d82786e60e043833f7",
  },
  {
    id: "default-with-annex",
    inputIndex: 1,
    hashType: 0x00,
    annex: "50deadbeefcafe",
    expected: "289d37f5d429ad716070ed1ab9ddbd47e1ff3130aa89329b75f07f4e5d02f046",
  },
  {
    id: "single-with-annex",
    inputIndex: 2,
    hashType: 0x03,
    annex: "50aabbccddeeff0011",
    expected: "59ec34faf224248632fcf862ef5c164c725d7eb9331f5b3bc92b3d36267e4950",
  },
]

describe("COMPLETE-v2 BIP-341 key-path sighash", () => {
  it("matches the published full sighash-mode and annex vectors", () => {
    const transaction = Transaction.fromHex(FULL_SIGHASH_TRANSACTION_HEX)
    const commitments = computeP2TRKeyPathSharedCommitments(
      transaction,
      FULL_SIGHASH_PREVOUTS
    )
    const scripts = FULL_SIGHASH_PREVOUTS.map((prevout) =>
      Buffer.from(prevout.scriptPubKey)
    )
    const values = FULL_SIGHASH_PREVOUTS.map((prevout) =>
      Number(prevout.valueSats)
    )

    for (const vector of FULL_SIGHASH_CASES) {
      const annex =
        vector.annex === undefined
          ? undefined
          : Buffer.from(vector.annex, "hex")
      const actual = calculateP2TRKeyPathSighash({
        transaction,
        inputIndex: vector.inputIndex,
        hashType: vector.hashType,
        annex,
        currentPrevout: FULL_SIGHASH_PREVOUTS[vector.inputIndex],
        commitments,
      })
      const bitcoinjsReference = transaction
        .hashForWitnessV1(
          vector.inputIndex,
          scripts,
          values,
          vector.hashType,
          undefined,
          annex
        )
        .toString("hex")

      assert.equal(actual, vector.expected, vector.id)
      assert.equal(actual, bitcoinjsReference, `${vector.id} reference`)
    }
  })

  it("pins display-order txids to little-endian wire outpoints", () => {
    const transaction = Transaction.fromHex(
      "0200000001ffeeddccbbaa998877665544332211001032547698badcfeefcdab89674523010300000000fdffffff010070991400000000225120999999999999999999999999999999999999999999999999999999999999999900000000"
    )
    const prevout: P2TRBIP341Prevout = {
      txid: "0123456789abcdeffedcba987654321000112233445566778899aabbccddeeff",
      vout: 3,
      valueSats: 345_678_901,
      scriptPubKey: Buffer.from(
        "5120fff97bd5755eeea420453a14355235d382f6472f8568a18b2f057a1460297556",
        "hex"
      ),
    }
    const commitments = computeP2TRKeyPathSharedCommitments(transaction, [
      prevout,
    ])

    assert.equal(
      displayTxidFromWireHash(transaction.ins[0].hash),
      prevout.txid
    )
    assert.deepEqual(
      serializeBitcoinOutpointFromDisplayTxid(prevout.txid, prevout.vout),
      Buffer.concat([
        Buffer.from(transaction.ins[0].hash),
        Buffer.from("03000000", "hex"),
      ])
    )
    assert.equal(
      calculateP2TRKeyPathSighash({
        transaction,
        inputIndex: 0,
        hashType: P2TR_SIGHASH_DEFAULT,
        currentPrevout: prevout,
        commitments,
      }),
      "adb4b8782ac45dd6a72e0c8b2334e336dbf90c339a937c7157ac54bbc9157413"
    )

    assert.throws(
      () =>
        computeP2TRKeyPathSharedCommitments(transaction, [
          {
            ...prevout,
            txid: Buffer.from(prevout.txid, "hex").reverse().toString("hex"),
          },
        ]),
      /display-order prevout does not match transaction input outpoint/
    )
  })

  it("uses CompactSize for scripts across its length-prefix boundaries", () => {
    assert.equal(encodeBitcoinCompactSize(252).toString("hex"), "fc")
    assert.equal(encodeBitcoinCompactSize(253).toString("hex"), "fdfd00")
    assert.equal(encodeBitcoinCompactSize(65_535).toString("hex"), "fdffff")
    assert.equal(
      encodeBitcoinCompactSize(65_536).toString("hex"),
      "fe00000100"
    )

    const transaction = new Transaction()
    transaction.version = 2
    transaction.locktime = 500_000
    transaction.addInput(
      Buffer.from(Array.from({ length: 32 }, (_, index) => index)),
      7,
      0xfffffffd
    )
    transaction.addInput(
      Buffer.from(Array.from({ length: 32 }, (_, index) => 0xff - index)),
      9,
      0xfffffffc
    )
    transaction.addOutput(Buffer.alloc(252, 0x51), 10_000)
    transaction.addOutput(Buffer.alloc(253, 0x52), 20_000)
    const prevouts: readonly P2TRBIP341Prevout[] = [
      {
        txid: displayTxidFromWireHash(transaction.ins[0].hash),
        vout: 7,
        valueSats: 30_000,
        scriptPubKey: Buffer.alloc(252, 0x53),
      },
      {
        txid: displayTxidFromWireHash(transaction.ins[1].hash),
        vout: 9,
        valueSats: 40_000,
        scriptPubKey: Buffer.alloc(253, 0x54),
      },
    ]
    const commitments = computeP2TRKeyPathSharedCommitments(
      transaction,
      prevouts
    )
    const actual = calculateP2TRKeyPathSighash({
      transaction,
      inputIndex: 1,
      hashType: P2TR_SIGHASH_DEFAULT,
      currentPrevout: prevouts[1],
      commitments,
    })
    const reference = transaction
      .hashForWitnessV1(
        1,
        prevouts.map((prevout) => Buffer.from(prevout.scriptPubKey)),
        prevouts.map((prevout) => Number(prevout.valueSats)),
        P2TR_SIGHASH_DEFAULT
      )
      .toString("hex")

    assert.equal(actual, reference)
  })

  it("rejects SINGLE when the signed input has no corresponding output", () => {
    const transaction = Transaction.fromHex(FULL_SIGHASH_TRANSACTION_HEX)
    transaction.outs.pop()
    const commitments = computeP2TRKeyPathSharedCommitments(
      transaction,
      FULL_SIGHASH_PREVOUTS
    )

    for (const hashType of [
      P2TR_SIGHASH_SINGLE,
      P2TR_SIGHASH_ANYONECANPAY_SINGLE,
    ] as const) {
      assert.throws(
        () =>
          calculateP2TRKeyPathSighash({
            transaction,
            inputIndex: 2,
            hashType,
            currentPrevout: FULL_SIGHASH_PREVOUTS[2],
            commitments,
          }),
        /SIGHASH_SINGLE requires a corresponding transaction output/
      )
    }
  })

  it("rejects a malformed annex before hashing", () => {
    const transaction = Transaction.fromHex(FULL_SIGHASH_TRANSACTION_HEX)
    const commitments = computeP2TRKeyPathSharedCommitments(
      transaction,
      FULL_SIGHASH_PREVOUTS
    )

    assert.throws(
      () =>
        calculateP2TRKeyPathSighash({
          transaction,
          inputIndex: 0,
          hashType: P2TR_SIGHASH_DEFAULT,
          annex: Buffer.from("51", "hex"),
          currentPrevout: FULL_SIGHASH_PREVOUTS[0],
          commitments,
        }),
      (error) =>
        error instanceof P2TRWitnessError && error.code === "invalid-annex"
    )
  })
})

describe("COMPLETE-v2 Taproot witness parsing", () => {
  const signature = Buffer.concat([
    Buffer.alloc(32, 0x11),
    Buffer.alloc(32, 0x22),
  ])

  it("parses canonical default and explicit key-path signatures", () => {
    const defaultWitness = classifyP2TRWitness([signature])
    assert.equal(defaultWitness.kind, "key-path")
    if (defaultWitness.kind !== "key-path") return
    assert.equal(defaultWitness.sighashType, P2TR_SIGHASH_DEFAULT)
    assert.equal(defaultWitness.nonceX.toString("hex"), "11".repeat(32))
    assert.equal(
      defaultWitness.signatureScalar.toString("hex"),
      "22".repeat(32)
    )
    assert.deepEqual(defaultWitness.signature, signature)
    assert.deepEqual(defaultWitness.witnessSignature, signature)

    for (const hashType of P2TR_KEY_PATH_SIGHASH_TYPES.slice(1)) {
      const serialized = Buffer.concat([signature, Buffer.from([hashType])])
      const parsed = parseP2TRKeyPathSignature([serialized])
      assert.equal(parsed?.sighashType, hashType)
      assert.deepEqual(parsed?.witnessSignature, serialized)
      assert.deepEqual(parsed?.signature, signature)
    }
  })

  it("recognizes an annex only when BIP-341's two-item rule applies", () => {
    const annex = Buffer.from("50deadbeef", "hex")
    const parsed = classifyP2TRWitness([signature, annex])
    assert.equal(parsed.kind, "key-path")
    if (parsed.kind !== "key-path") return
    assert.deepEqual(parsed.annex, annex)

    assert.throws(
      () => classifyP2TRWitness([Buffer.from([0x50])]),
      (error) =>
        error instanceof P2TRWitnessError &&
        error.code === "invalid-signature-length"
    )
  })

  it("returns terminal empty and script-path classifications", () => {
    assert.deepEqual(classifyP2TRWitness([]), { kind: "empty" })
    assert.equal(parseP2TRKeyPathSignature([]), undefined)

    const script = Buffer.from("51", "hex")
    const controlBlock = Buffer.concat([
      Buffer.from([0xc0]),
      Buffer.alloc(32, 0x33),
    ])
    const annex = Buffer.from("50aabb", "hex")
    const parsed = classifyP2TRWitness([
      Buffer.from("01", "hex"),
      script,
      controlBlock,
      annex,
    ])
    assert.equal(parsed.kind, "script-path")
    if (parsed.kind !== "script-path") return
    assert.deepEqual(parsed.script, script)
    assert.deepEqual(parsed.controlBlock, controlBlock)
    assert.deepEqual(parsed.annex, annex)
    assert.equal(parsed.stackItemCount, 1)
    assert.equal(
      parseP2TRKeyPathSignature([script, controlBlock, annex]),
      undefined
    )
  })

  it("rejects explicit zero, bare 0x80, and malformed signature lengths", () => {
    const explicitZero = Buffer.concat([signature, Buffer.from([0x00])])
    assert.throws(
      () => classifyP2TRWitness([explicitZero]),
      (error) =>
        error instanceof P2TRWitnessError &&
        error.code === "explicit-default-sighash"
    )

    const bareAnyoneCanPay = Buffer.concat([
      signature,
      Buffer.from([0x80]),
    ])
    assert.throws(
      () => classifyP2TRWitness([bareAnyoneCanPay]),
      (error) =>
        error instanceof P2TRWitnessError &&
        error.code === "unsupported-sighash"
    )

    for (const malformed of [
      Buffer.alloc(63),
      Buffer.alloc(66),
      Buffer.from([0x80]),
    ]) {
      assert.throws(
        () => classifyP2TRWitness([malformed]),
        (error) =>
          error instanceof P2TRWitnessError &&
          error.code === "invalid-signature-length"
      )
    }
  })
})
