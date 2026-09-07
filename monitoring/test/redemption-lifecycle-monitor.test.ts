import assert from "assert"
import { promises as fs } from "fs"
import { tmpdir } from "os"
import { join } from "path"

import { BitcoinTxHash } from "@keep-network/tbtc-v2.ts"

import { RedemptionLifecycleMonitor } from "../src/redemption-lifecycle-monitor"
import { Manager, SystemEventType } from "../src/system-event"
import { blocks } from "../src/blocks"
import { SystemEventFilePersistence } from "../src/file-persistence"
import { context } from "../src/context"

import { redemptionRequest } from "./redemption-fixtures"
import { test } from "./test-runner"

import type { RedemptionRequestedEvent } from "@keep-network/tbtc-v2.ts"
import type {
  RedemptionLifecycleSource,
  RedemptionsCompletedEvent,
  RedemptionTimedOutEvent,
} from "../src/redemption-chain"
import type {
  BlockRange,
  Persistence,
  Receiver,
  SystemEvent,
} from "../src/system-event"

class Chain implements RedemptionLifecycleSource {
  requests = [redemptionRequest()]

  completions: RedemptionsCompletedEvent[] = []

  reports: RedemptionTimedOutEvent[] = []

  // Test cases replace the clock and contract configuration independently.
  // eslint-disable-next-line class-methods-use-this
  timestampAt = (block: number) => block * 10

  // eslint-disable-next-line class-methods-use-this
  timeoutAt: (block: number) => number = () => 1000

  pendingAt: (request: RedemptionRequestedEvent, block: number) => number = (
    request
  ) => this.timestampAt(request.blockNumber)

  stateReads: number[] = []

  timestampReads: number[] = []

  requestQueries: [number, number][] = []

  async requested(from: number, to: number) {
    this.requestQueries.push([from, to])
    return this.requests.filter(
      (event) => event.blockNumber >= from && event.blockNumber <= to
    )
  }

  async completed(from: number, to: number) {
    return this.completions.filter(
      (event) => event.blockNumber >= from && event.blockNumber <= to
    )
  }

  async timedOut(from: number, to: number) {
    return this.reports.filter(
      (event) => event.blockNumber >= from && event.blockNumber <= to
    )
  }

  async timeout(block: number) {
    return this.timeoutAt(block)
  }

  async blockTimestamp(block: number) {
    this.timestampReads.push(block)
    return this.timestampAt(block)
  }

  async pendingRequestedAt(request: RedemptionRequestedEvent, block: number) {
    this.stateReads.push(block)
    return this.pendingAt(request, block)
  }
}

test("redemption deadline warning and strict expiry boundaries", async () => {
  const chain = new Chain()
  const monitor = new RedemptionLifecycleMonitor(chain, 200)
  assert.deepStrictEqual(await monitor.check(80, 89), [])
  const [near] = await monitor.check(80, 90)
  assert.strictEqual(near.title, "Redemption nearing timeout")
  assert.strictEqual(near.type, SystemEventType.Warning)
  assert.strictEqual(near.data.deadlineTimestamp, "1100")
  assert.strictEqual(near.block, 10)
  assert.deepStrictEqual(await monitor.check(110, 110), [])
  const [expired] = await monitor.check(110, 111)
  assert.strictEqual(expired.title, "Redemption expired without proof")
  assert.strictEqual(expired.type, SystemEventType.Critical)
  assert.strictEqual(expired.data.deadlineTimestamp, "1100")
  assert.deepStrictEqual(chain.stateReads, [90, 111])
})

test("deadline scans follow irregular block timestamps and cache each header", async () => {
  const chain = new Chain()
  const times = [0, 100, 400, 500, 700, 900, 1000, 1080, 1100, 1150, 1200]
  chain.timestampAt = (block) => times[block]
  chain.requests = [redemptionRequest(1)]
  const monitor = new RedemptionLifecycleMonitor(chain, 200)
  assert.strictEqual(
    (await monitor.check(4, 5))[0].type,
    SystemEventType.Warning
  )
  assert.strictEqual(
    new Set(chain.timestampReads).size,
    chain.timestampReads.length
  )
  assert.strictEqual(
    (await monitor.check(8, 9))[0].type,
    SystemEventType.Critical
  )
})

test("completed requests and reused wallet/script keys do not alert for the old request", async () => {
  const chain = new Chain()
  const monitor = new RedemptionLifecycleMonitor(chain, 200)
  chain.pendingAt = () => 0
  assert.deepStrictEqual(await monitor.check(80, 90), [])
  chain.requests.push(redemptionRequest(30, "66"))
  chain.pendingAt = () => 300
  assert.deepStrictEqual(await monitor.check(80, 90), [])
  const events = await monitor.check(100, 110)
  assert.strictEqual(events.length, 1)
  assert.strictEqual(events[0].data.ethRequestTxHash, `0x${"66".repeat(32)}`)
})

test("a coarse catch-up window emits expiry instead of a stale near-timeout warning", async () => {
  const events = await new RedemptionLifecycleMonitor(new Chain(), 200).check(
    80,
    120
  )
  assert.strictEqual(events.length, 1)
  assert.strictEqual(events[0].type, SystemEventType.Critical)
})

test("a timeout reduction detects a request newly expired by governance", async () => {
  const chain = new Chain()
  chain.timeoutAt = (block) => (block < 95 ? 2000 : 700)
  const [event] = await new RedemptionLifecycleMonitor(chain, 200).check(
    90,
    100
  )
  assert.strictEqual(event.type, SystemEventType.Critical)
  assert.strictEqual(event.data.deadlineTimestamp, "800")
})

test("a timeout extension avoids a false expiration", async () => {
  const chain = new Chain()
  chain.timeoutAt = (block) => (block < 115 ? 1000 : 2000)
  assert.deepStrictEqual(
    await new RedemptionLifecycleMonitor(chain, 200).check(110, 120),
    []
  )
})

test("a short contract timeout clamps the warning lead time to request creation", async () => {
  const chain = new Chain()
  chain.timeoutAt = () => 100
  const [event] = await new RedemptionLifecycleMonitor(chain, 200).check(9, 10)
  assert.strictEqual(event.type, SystemEventType.Warning)
  assert.strictEqual(event.data.deadlineTimestamp, "200")
})

test("proof acceptance and accepted timeout reports have distinct stable event payloads", async () => {
  const chain = new Chain()
  chain.requests = []
  chain.completions = [
    {
      ...redemptionRequest(95),
      redemptionTxHash: BitcoinTxHash.from(`ab${"00".repeat(30)}01`),
    },
  ]
  chain.reports = [redemptionRequest(96, "77")]
  const events = await new RedemptionLifecycleMonitor(chain).check(90, 100)
  assert.deepStrictEqual(
    events.map((event) => [event.title, event.type, event.block]),
    [
      ["Redemption proof accepted", SystemEventType.Informational, 95],
      ["Redemption timeout reported", SystemEventType.Critical, 96],
    ]
  )
  assert.ok(
    events[0].data.redemptionTxHashURL.endsWith(events[0].data.redemptionTxHash)
  )
  assert.ok(
    events[0].data.ethProofTxHashURL.endsWith(events[0].data.ethProofTxHash)
  )
  assert.ok(
    events[1].data.ethTimeoutTxHashURL.endsWith(events[1].data.ethTimeoutTxHash)
  )
})

test("overlapping windows deduplicate the same deadline alert through Manager", async () => {
  const chain = new Chain()
  const monitor = new RedemptionLifecycleMonitor(chain, 200)
  const stored = await monitor.check(80, 91)
  assert.deepStrictEqual(await monitor.check(85, 92), stored)
  let delivered = false
  const receiver: Receiver = {
    id: () => "test",
    receive: async (event) => {
      delivered = true
      return { receiverId: "test", systemEvent: event, status: "handled" }
    },
  }
  const persistence: Persistence = {
    checkpointBlock: async () => 91,
    updateCheckpointBlock: async () => undefined,
    pendingBlockRange: async () => null,
    updatePendingBlockRange: async () => undefined,
    pendingSystemEvents: async () => ({}),
    updatePendingSystemEvents: async () => undefined,
    handledSystemEvents: async () => ({ test: stored }),
    storeHandledSystemEvents: async () => undefined,
  }
  const report = await new Manager([monitor], [receiver], persistence).check(
    85,
    92
  )
  assert.deepStrictEqual(report.errors, [])
  assert.strictEqual(report.systemEventsAcks[0].status, "duplicate")
  assert.strictEqual(delivered, false)
})

test("a failed historical RPC read preserves the Manager checkpoint and retries the same notification", async () => {
  const chain = new Chain()
  chain.pendingAt = () => {
    throw new Error("historical state unavailable")
  }
  let checkpoint = 90
  let pendingRange: BlockRange | null = null
  const events: SystemEvent[] = []
  const receiver: Receiver = {
    id: () => "test",
    receive: async (event) => {
      events.push(event)
      return { receiverId: "test", systemEvent: event, status: "handled" }
    },
  }
  const persistence: Persistence = {
    checkpointBlock: async () => checkpoint,
    updateCheckpointBlock: async (block) => {
      checkpoint = block
    },
    pendingBlockRange: async () => pendingRange,
    updatePendingBlockRange: async (range) => {
      pendingRange = range
    },
    pendingSystemEvents: async () => ({}),
    updatePendingSystemEvents: async () => undefined,
    handledSystemEvents: async () => ({}),
    storeHandledSystemEvents: async () => undefined,
  }
  const originalLatest = blocks.latestBlock
  blocks.latestBlock = async () => 92
  try {
    const manager = new Manager(
      [new RedemptionLifecycleMonitor(chain, 200)],
      [receiver],
      persistence
    )
    const failed = await manager.trigger()
    assert.strictEqual(failed.status, "failure")
    assert.ok(
      failed.errors.some((error) =>
        error.includes("historical state unavailable")
      )
    )
    assert.strictEqual(checkpoint, 90)
    assert.strictEqual(events.length, 0)
    chain.pendingAt = () => 100
    assert.strictEqual((await manager.trigger()).status, "success")
    assert.strictEqual(checkpoint, 92)
    assert.strictEqual(events.length, 1)
  } finally {
    blocks.latestBlock = originalLatest
  }
})

test("a rejected expiration survives restart and proof acceptance before retry", async () => {
  const originalDataDir = context.dataDirPath
  const originalLatest = blocks.latestBlock
  const directory = await fs.mkdtemp(
    join(tmpdir(), "redemption-delivery-retry-")
  )
  context.dataDirPath = directory
  let latestBlock = 111
  blocks.latestBlock = async () => latestBlock
  try {
    const chain = new Chain()
    chain.pendingAt = (request, block) =>
      block < 112 ? chain.timestampAt(request.blockNumber) : 0
    chain.completions = [
      {
        ...redemptionRequest(112),
        redemptionTxHash: BitcoinTxHash.from("aa".repeat(32)),
      },
    ]
    const attempts: SystemEvent[] = []
    let reject = true
    const receiver: Receiver = {
      id: () => "test",
      receive: async (event) => {
        attempts.push(event)
        if (reject) throw new Error("Sentry delivery failed")
        return { receiverId: "test", systemEvent: event, status: "handled" }
      },
    }
    const persistence = new SystemEventFilePersistence()
    await persistence.updateCheckpointBlock(110)
    const createManager = () =>
      new Manager(
        [new RedemptionLifecycleMonitor(chain, 200)],
        [receiver],
        new SystemEventFilePersistence()
      )
    const failed = await createManager().trigger()
    assert.strictEqual(failed.status, "failure")
    assert.strictEqual(attempts[0].title, "Redemption expired without proof")
    assert.strictEqual(
      await new SystemEventFilePersistence().checkpointBlock(),
      111
    )

    latestBlock = 120
    reject = false
    // Recreate both Manager and persistence, as the scheduled job does.
    const retried = await createManager().trigger()
    assert.strictEqual(retried.status, "success")
    assert.strictEqual(retried.toBlock, 120)
    assert.deepStrictEqual(attempts[1], attempts[0])
    assert.strictEqual(
      await new SystemEventFilePersistence().checkpointBlock(),
      120
    )

    const caughtUp = await createManager().trigger()
    assert.strictEqual(caughtUp.status, "success")
    assert.strictEqual(caughtUp.toBlock, 120)
    assert.deepStrictEqual(
      attempts.map((event) => event.title),
      [
        "Redemption expired without proof",
        "Redemption expired without proof",
        "Redemption proof accepted",
      ]
    )
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
})

test("invalid timeout configuration fails explicitly", async () => {
  const warnings = [0, -1, 0.5, Number.NaN, Infinity]
  warnings.forEach((warning) => {
    assert.throws(
      () => new RedemptionLifecycleMonitor(new Chain(), warning),
      /positive integer/
    )
  })
  const chain = new Chain()
  chain.timeoutAt = () => 0
  await assert.rejects(
    () => new RedemptionLifecycleMonitor(chain).check(90, 100),
    /invalid Bridge/
  )
})
