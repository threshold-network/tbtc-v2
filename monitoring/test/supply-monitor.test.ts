import assert from "assert"

import { BigNumber } from "ethers"
import { EthereumAddress } from "@keep-network/tbtc-v2.ts/core"

import { SupplyMonitor } from "../src/supply-monitor"
import { SystemEventType } from "../src/system-event"

import { test } from "./test-runner"

import type { TBTCToken } from "@keep-network/tbtc-v2.ts/core"

function monitor(referenceSupply: number, currentSupply: number) {
  let lastAlertBlock = 0
  const token: TBTCToken = {
    getChainIdentifier: () => EthereumAddress.from(`0x${"11".repeat(20)}`),
    totalSupply: async (block = 4000) =>
      BigNumber.from(block < 4000 ? referenceSupply : currentSupply),
    requestRedemption: async () => {
      throw new Error("The supply fixture cannot send redemptions")
    },
    buildRequestRedemptionData: () => {
      throw new Error("The supply fixture cannot build redemptions")
    },
  }
  return {
    supply: new SupplyMonitor(token, {
      lastHighTotalSupplyChangeBlock: async () => lastAlertBlock,
      updateLastHighTotalSupplyChangeBlock: async (block) => {
        lastAlertBlock = block
      },
    }),
    lastAlertBlock: () => lastAlertBlock,
  }
}

test("a normal supply increase at the threshold keeps its percentage alert", async () => {
  const fixture = monitor(1000, 1100)
  const events = await fixture.supply.check(3990, 4000)
  assert.deepStrictEqual(events, [
    {
      title: "High TBTC token total supply change",
      type: SystemEventType.Critical,
      data: { change: "+10%", threshold: "10%", referenceBlock: "400" },
      block: 4000,
    },
  ])
  assert.strictEqual(fixture.lastAlertBlock(), 4000)
})

test("unchanged zero supply is healthy and does not record a supply-change alert", async () => {
  const fixture = monitor(0, 0)
  assert.deepStrictEqual(await fixture.supply.check(3990, 4000), [])
  assert.strictEqual(fixture.lastAlertBlock(), 0)
})

test("first supply from zero alerts without a percentage and is not repeated", async () => {
  const fixture = monitor(0, 1000)
  assert.deepStrictEqual(await fixture.supply.check(3990, 4000), [
    {
      title: "High TBTC token total supply change",
      type: SystemEventType.Critical,
      data: {
        change: "undefined (zero reference supply)",
        threshold: "not applicable (zero reference supply)",
        referenceBlock: "400",
        referenceSupply: "0",
        supplyDifferenceBaseUnits: "1000",
      },
      block: 4000,
    },
  ])
  assert.strictEqual(fixture.lastAlertBlock(), 4000)
  assert.deepStrictEqual(await fixture.supply.check(4000, 4001), [])
  assert.strictEqual(fixture.lastAlertBlock(), 4000)
})
