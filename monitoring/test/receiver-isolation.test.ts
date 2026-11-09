import assert from "assert"
import { promises as fs } from "fs"
import { tmpdir } from "os"
import { join } from "path"

import { blocks } from "../src/blocks"
import { context } from "../src/context"
import { SystemEventFilePersistence } from "../src/file-persistence"
import { Manager, SystemEventType } from "../src/system-event"

import { test } from "./test-runner"

import type { Monitor, Receiver, SystemEvent } from "../src/system-event"

async function withDataDirectory(run: () => Promise<void>): Promise<void> {
  const originalDataDir = context.dataDirPath
  const originalLatest = blocks.latestBlock
  const directory = await fs.mkdtemp(join(tmpdir(), "receiver-isolation-"))
  context.dataDirPath = directory
  try {
    await run()
  } finally {
    context.dataDirPath = originalDataDir
    blocks.latestBlock = originalLatest
    await Promise.all(
      (
        await fs.readdir(directory)
      ).map((name) => fs.unlink(join(directory, name)))
    )
    await fs.rmdir(directory)
  }
}

test("a receiver outage preserves retries while newer critical events reach a healthy receiver", async () => {
  await withDataDirectory(async () => {
    const informational: SystemEvent = {
      title: "Redemption proof accepted",
      type: SystemEventType.Informational,
      data: { transactionHash: "proof" },
      block: 100,
    }
    const critical: SystemEvent = {
      title: "Redemption timeout reported",
      type: SystemEventType.Critical,
      data: { transactionHash: "timeout" },
      block: 125,
    }
    const checkedRanges: [number, number][] = []
    const monitor: Monitor = {
      check: async (fromBlock, toBlock) => {
        checkedRanges.push([fromBlock, toBlock])
        return [informational, critical].filter(
          (event) => event.block >= fromBlock && event.block <= toBlock
        )
      },
    }
    let latestBlock = 100
    blocks.latestBlock = async () => latestBlock
    let discordUnavailable = true
    const discordDeliveries: SystemEvent[] = []
    const sentryDeliveries: SystemEvent[] = []
    const discord: Receiver = {
      id: () => "discord",
      receive: async (event) => {
        if (event.type !== SystemEventType.Informational) {
          return {
            receiverId: "discord",
            systemEvent: event,
            status: "ignored",
          }
        }
        if (discordUnavailable) throw new Error("Discord unavailable")
        discordDeliveries.push(event)
        return { receiverId: "discord", systemEvent: event, status: "handled" }
      },
    }
    const sentry: Receiver = {
      id: () => "sentry",
      receive: async (event) => {
        if (event.type !== SystemEventType.Critical) {
          return { receiverId: "sentry", systemEvent: event, status: "ignored" }
        }
        sentryDeliveries.push(event)
        return { receiverId: "sentry", systemEvent: event, status: "handled" }
      },
    }
    const createManager = () =>
      new Manager(
        [monitor],
        [discord, sentry],
        new SystemEventFilePersistence()
      )
    await new SystemEventFilePersistence().updateCheckpointBlock(99)

    const first = await createManager().trigger()
    assert.strictEqual(first.status, "failure")
    assert.ok(
      first.errors.some((error) => error.includes("Discord unavailable"))
    )
    assert.deepStrictEqual(discordDeliveries, [])
    assert.strictEqual(
      await new SystemEventFilePersistence().checkpointBlock(),
      100
    )
    assert.strictEqual(
      await new SystemEventFilePersistence().pendingBlockRange(),
      null
    )
    assert.deepStrictEqual(
      (await new SystemEventFilePersistence().pendingSystemEvents()).discord,
      [informational]
    )

    latestBlock = 130
    // Each trigger reloads the durable state, as a restarted scheduled job does.
    const second = await createManager().trigger()
    assert.strictEqual(second.status, "failure")
    assert.deepStrictEqual(sentryDeliveries, [critical])
    assert.deepStrictEqual(checkedRanges, [
      [87, 100],
      [88, 130],
    ])
    assert.strictEqual(
      await new SystemEventFilePersistence().checkpointBlock(),
      130
    )
    assert.deepStrictEqual(discordDeliveries, [])
    assert.deepStrictEqual(
      (await new SystemEventFilePersistence().pendingSystemEvents()).discord,
      [informational]
    )

    // The original notification is now outside the reorganization overlap.
    latestBlock = 160
    discordUnavailable = false
    assert.strictEqual((await createManager().trigger()).status, "success")
    assert.deepStrictEqual(discordDeliveries, [informational])
    assert.deepStrictEqual(sentryDeliveries, [critical])
    assert.strictEqual(
      await new SystemEventFilePersistence().checkpointBlock(),
      160
    )
    assert.deepStrictEqual(
      Object.values(
        await new SystemEventFilePersistence().pendingSystemEvents()
      ).flat(),
      []
    )

    latestBlock = 170
    assert.strictEqual((await createManager().trigger()).status, "success")
    assert.deepStrictEqual(discordDeliveries, [informational])
    assert.deepStrictEqual(sentryDeliveries, [critical])
  })
})

test("a temporarily unconfigured receiver keeps its durable notifications while scanning advances", async () => {
  await withDataDirectory(async () => {
    const event: SystemEvent = {
      title: "Redemption proof accepted",
      type: SystemEventType.Informational,
      data: { transactionHash: "proof" },
      block: 100,
    }
    const monitor: Monitor = {
      check: async (fromBlock, toBlock) =>
        event.block >= fromBlock && event.block <= toBlock ? [event] : [],
    }
    let latestBlock = 100
    blocks.latestBlock = async () => latestBlock
    let unavailable = true
    const deliveries: SystemEvent[] = []
    const receiver: Receiver = {
      id: () => "discord",
      receive: async (systemEvent) => {
        if (unavailable) throw new Error("Discord unavailable")
        deliveries.push(systemEvent)
        return { receiverId: "discord", systemEvent, status: "handled" }
      },
    }
    const trigger = (receivers: Receiver[]) =>
      new Manager(
        [monitor],
        receivers,
        new SystemEventFilePersistence()
      ).trigger()
    await new SystemEventFilePersistence().updateCheckpointBlock(99)
    assert.strictEqual((await trigger([receiver])).status, "failure")

    latestBlock = 130
    await trigger([])
    assert.strictEqual(
      await new SystemEventFilePersistence().checkpointBlock(),
      130
    )
    assert.deepStrictEqual(
      (await new SystemEventFilePersistence().pendingSystemEvents()).discord,
      [event]
    )

    latestBlock = 160
    unavailable = false
    assert.strictEqual((await trigger([receiver])).status, "success")
    assert.deepStrictEqual(deliveries, [event])
    assert.strictEqual(
      await new SystemEventFilePersistence().checkpointBlock(),
      160
    )
    assert.deepStrictEqual(
      Object.values(
        await new SystemEventFilePersistence().pendingSystemEvents()
      ).flat(),
      []
    )
  })
})

test("a failed outbox capture retains the scan window without delivering notifications", async () => {
  await withDataDirectory(async () => {
    const event: SystemEvent = {
      title: "Redemption expired without proof",
      type: SystemEventType.Critical,
      data: { transactionHash: "request" },
      block: 99,
    }
    const monitor: Monitor = {
      check: async (fromBlock, toBlock) =>
        event.block >= fromBlock && toBlock === 100 ? [event] : [],
    }
    let latestBlock = 100
    blocks.latestBlock = async () => latestBlock
    const deliveries: SystemEvent[] = []
    const receiver: Receiver = {
      id: () => "sentry",
      receive: async (systemEvent) => {
        deliveries.push(systemEvent)
        return { receiverId: "sentry", systemEvent, status: "handled" }
      },
    }
    const persistence = new SystemEventFilePersistence()
    await persistence.updateCheckpointBlock(99)
    persistence.updatePendingSystemEvents = async () => {
      throw new Error("outbox capture failed")
    }

    const failed = await new Manager(
      [monitor],
      [receiver],
      persistence
    ).trigger()
    assert.strictEqual(failed.status, "failure")
    assert.ok(
      failed.errors.some((error) => error.includes("outbox capture failed"))
    )
    assert.deepStrictEqual(deliveries, [])
    assert.strictEqual(
      await new SystemEventFilePersistence().checkpointBlock(),
      99
    )
    assert.deepStrictEqual(
      await new SystemEventFilePersistence().pendingBlockRange(),
      { fromBlock: 87, toBlock: 100 }
    )
    assert.deepStrictEqual(
      await new SystemEventFilePersistence().pendingSystemEvents(),
      {}
    )

    latestBlock = 130
    const recovered = await new Manager(
      [monitor],
      [receiver],
      new SystemEventFilePersistence()
    ).trigger()
    assert.strictEqual(recovered.status, "success")
    assert.strictEqual(recovered.fromBlock, 87)
    assert.strictEqual(recovered.toBlock, 100)
    assert.deepStrictEqual(deliveries, [event])
    assert.strictEqual(
      await new SystemEventFilePersistence().checkpointBlock(),
      100
    )
    assert.strictEqual(
      await new SystemEventFilePersistence().pendingBlockRange(),
      null
    )
    assert.deepStrictEqual(
      await new SystemEventFilePersistence().pendingSystemEvents(),
      {}
    )
  })
})

test("a failed handled-history save retains captured notifications for at-least-once replay", async () => {
  await withDataDirectory(async () => {
    const event: SystemEvent = {
      title: "Redemption expired without proof",
      type: SystemEventType.Critical,
      data: { transactionHash: "request" },
      block: 99,
    }
    const monitor: Monitor = {
      // A proof accepted after block 100 removes this notification from new scans.
      check: async (fromBlock, toBlock) =>
        event.block >= fromBlock && toBlock === 100 ? [event] : [],
    }
    let latestBlock = 100
    blocks.latestBlock = async () => latestBlock
    const deliveries: SystemEvent[] = []
    const receiver: Receiver = {
      id: () => "sentry",
      receive: async (systemEvent) => {
        deliveries.push(systemEvent)
        return { receiverId: "sentry", systemEvent, status: "handled" }
      },
    }
    const persistence = new SystemEventFilePersistence()
    await persistence.updateCheckpointBlock(99)
    persistence.storeHandledSystemEvents = async () => {
      throw new Error("handled-history save failed")
    }

    const failed = await new Manager(
      [monitor],
      [receiver],
      persistence
    ).trigger()
    assert.strictEqual(failed.status, "failure")
    assert.ok(
      failed.errors.some((error) =>
        error.includes("handled-history save failed")
      )
    )
    assert.deepStrictEqual(deliveries, [event])
    assert.strictEqual(
      await new SystemEventFilePersistence().checkpointBlock(),
      100
    )
    assert.strictEqual(
      await new SystemEventFilePersistence().pendingBlockRange(),
      null
    )
    assert.deepStrictEqual(
      await new SystemEventFilePersistence().pendingSystemEvents(),
      { sentry: [event] }
    )
    assert.deepStrictEqual(
      await new SystemEventFilePersistence().handledSystemEvents(),
      {}
    )

    latestBlock = 130
    const recovered = await new Manager(
      [monitor],
      [receiver],
      new SystemEventFilePersistence()
    ).trigger()
    assert.strictEqual(recovered.status, "success")
    assert.strictEqual(recovered.toBlock, 130)
    assert.deepStrictEqual(deliveries, [event, event])
    assert.strictEqual(
      await new SystemEventFilePersistence().checkpointBlock(),
      130
    )
    assert.deepStrictEqual(
      await new SystemEventFilePersistence().pendingSystemEvents(),
      {}
    )
    assert.deepStrictEqual(
      await new SystemEventFilePersistence().handledSystemEvents(),
      { sentry: [event] }
    )
  })
})
