import assert from "node:assert/strict"
import { describe, it } from "node:test"
import {
  P2TR_FROST_WALLET_GROUP_INVENTORY_SCHEMA,
  computeP2TRFrostWalletGroupInventory,
  type P2TRFrostWalletGroupInventoryEntry,
} from "../src/P2TRProductionActivation.js"

const point = { blockNumber: 120, blockHash: `0x${"12".repeat(32)}` }

const entry = (
  walletByte: string,
  actualGroupSize: number,
  lifecycle: P2TRFrostWalletGroupInventoryEntry["lifecycle"] = "live"
): P2TRFrostWalletGroupInventoryEntry => ({
  walletID: `0x${walletByte.repeat(32)}`,
  retainedGroupHash: `0x${"ab".repeat(31)}${walletByte}`,
  actualGroupSize,
  lifecycle,
  creationPoint: {
    blockNumber: 20,
    blockHash: `0x${"20".repeat(32)}`,
    transactionHash: `0x${"21".repeat(32)}`,
    transactionIndex: 1,
    logIndex: 4,
  },
  bridgeRegistrationPoint: {
    blockNumber: 20,
    blockHash: `0x${"20".repeat(32)}`,
    transactionHash: `0x${"21".repeat(32)}`,
    transactionIndex: 1,
    logIndex: 5,
  },
  lifecyclePoint: {
    blockNumber: lifecycle === "live" ? 20 : 80,
    blockHash: `0x${(lifecycle === "live" ? "20" : "80").repeat(32)}`,
    transactionHash: `0x${(lifecycle === "live" ? "21" : "81").repeat(32)}`,
    transactionIndex: 1,
    logIndex: lifecycle === "live" ? 5 : 2,
  },
  ...(lifecycle === "closed" || lifecycle === "terminated"
    ? {
        registryClosurePoint: {
          blockNumber: 80,
          blockHash: `0x${"80".repeat(32)}`,
          transactionHash: `0x${"81".repeat(32)}`,
          transactionIndex: 1,
          logIndex: 3,
        },
      }
    : {}),
})

describe("FROST retained-group inventory", () => {
  it("commits exact 51..100 retained groups independently of input order", () => {
    const entries = [
      entry("01", 51),
      entry("02", 73, "closing"),
      entry("03", 100, "closed"),
    ]
    const left = computeP2TRFrostWalletGroupInventory(point, 9, entries)
    const right = computeP2TRFrostWalletGroupInventory(
      point,
      9,
      [...entries].reverse()
    )

    assert.deepEqual(left, right)
    assert.equal(left.schema, P2TR_FROST_WALLET_GROUP_INVENTORY_SCHEMA)
    assert.equal(left.walletCount, 3)
    assert.equal(left.minimumActualGroupSize, 51)
    assert.equal(left.maximumActualGroupSize, 100)
  })

  it("binds lifecycle history and signer snapshot generation", () => {
    const live = computeP2TRFrostWalletGroupInventory(point, 9, [
      entry("01", 51, "live"),
    ])
    const closing = computeP2TRFrostWalletGroupInventory(point, 9, [
      entry("01", 51, "closing"),
    ])
    const nextGeneration = computeP2TRFrostWalletGroupInventory(point, 10, [
      entry("01", 51, "live"),
    ])

    assert.notEqual(live.inventoryRoot, closing.inventoryRoot)
    assert.notEqual(live.inventoryRoot, nextGeneration.inventoryRoot)
  })

  it("rejects ambiguous or unsafe retained groups", () => {
    assert.throws(
      () =>
        computeP2TRFrostWalletGroupInventory(point, 1, [
          entry("01", 51),
          entry("01", 51),
        ]),
      /ambiguous wallet membership/
    )
    assert.throws(
      () => computeP2TRFrostWalletGroupInventory(point, 1, [entry("01", 50)]),
      /between 51 and 100/
    )
    assert.throws(
      () => computeP2TRFrostWalletGroupInventory(point, 1, [entry("01", 101)]),
      /between 51 and 100/
    )
  })
})
