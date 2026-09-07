import assert from "assert"

import { Manager, SystemEventType } from "../src/system-event"
import { blocks } from "../src/blocks"

import { test } from "./test-runner"

import type {
  BlockRange,
  Monitor,
  Persistence,
  Receiver,
  SystemEvent,
} from "../src/system-event"

const systemEvent: SystemEvent = {
  title: "wallet is moving funds",
  type: SystemEventType.Warning,
  data: {
    wallet: "0xabcd",
  },
  block: 120,
}

const monitor: Monitor = {
  check: async () => [systemEvent],
}

function persistence(
  handledSystemEvents: Awaited<ReturnType<Persistence["handledSystemEvents"]>>
): Persistence {
  return {
    checkpointBlock: async () => 0,
    updateCheckpointBlock: async () => undefined,
    pendingBlockRange: async () => null,
    updatePendingBlockRange: async () => undefined,
    handledSystemEvents: async () => handledSystemEvents,
    storeHandledSystemEvents: async () => undefined,
  }
}

test("Manager does not error when all receivers ignore a system event (partial-receiver deployment)", async () => {
  const receiver: Receiver = {
    id: () => "Noop",
    receive: async (receivedEvent) => ({
      receiverId: "Noop",
      systemEvent: receivedEvent,
      status: "ignored",
    }),
  }

  const manager = new Manager([monitor], [receiver], persistence({}))
  const report = await manager.check(100, 200)

  assert.deepStrictEqual(report.errors, [])
})

test("Manager reports dispatch error without coverage error when receiver throws", async () => {
  const receiver: Receiver = {
    id: () => "Throws",
    receive: async () => {
      throw new Error("delivery failed")
    },
  }

  const manager = new Manager([monitor], [receiver], persistence({}))
  const report = await manager.check(100, 200)

  assert.strictEqual(report.errors.length, 1)
  assert.ok(report.errors[0].includes("cannot dispatch system event"))
})

test("Manager treats duplicate system events as already covered", async () => {
  let receiverCalled = false
  const receiver: Receiver = {
    id: () => "Noop",
    receive: async (receivedEvent) => {
      receiverCalled = true

      return {
        receiverId: "Noop",
        systemEvent: receivedEvent,
        status: "ignored",
      }
    },
  }

  const manager = new Manager(
    [monitor],
    [receiver],
    persistence({
      Noop: [systemEvent],
    })
  )
  const report = await manager.check(100, 200)

  assert.deepStrictEqual(report.errors, [])
  assert.strictEqual(report.systemEventsAcks[0].status, "duplicate")
  assert.strictEqual(receiverCalled, false)
})

test("Manager requires a durable range before checking, including a retry after a failed save", async () => {
  const originalLatest = blocks.latestBlock
  blocks.latestBlock = async () => 150
  let pending: BlockRange | null = null
  let checks = 0
  const state = persistence({})
  state.pendingBlockRange = async () => pending
  state.updatePendingBlockRange = async (range) => {
    // File persistence can update its cache before the disk write fails.
    pending = range
    throw new Error("cannot save range")
  }
  const manager = new Manager(
    [
      {
        check: async () => {
          checks += 1
          return []
        },
      },
    ],
    [],
    state
  )
  try {
    assert.strictEqual((await manager.trigger()).status, "failure")
    assert.strictEqual((await manager.trigger()).status, "failure")
    assert.strictEqual(checks, 0)
  } finally {
    blocks.latestBlock = originalLatest
  }
})

test("Manager retains a failed delivery range and deduplicates the receiver that already accepted it", async () => {
  const originalLatest = blocks.latestBlock
  let latestBlock = 150
  blocks.latestBlock = async () => latestBlock
  let checkpoint = 100
  let pending: BlockRange | null = null
  const handled: Record<string, SystemEvent[]> = {}
  const state = persistence(handled)
  state.checkpointBlock = async () => checkpoint
  state.updateCheckpointBlock = async (block) => {
    checkpoint = block
  }
  state.pendingBlockRange = async () => pending
  state.updatePendingBlockRange = async (range) => {
    pending = range
  }
  state.storeHandledSystemEvents = async (events) => {
    Object.entries(events).forEach(([id, accepted]) => {
      handled[id] = [...(handled[id] ?? []), ...accepted]
    })
  }
  let acceptedCalls = 0
  let rejectedCalls = 0
  let reject = true
  const receivers: Receiver[] = [
    {
      id: () => "accepted",
      receive: async (event) => {
        acceptedCalls += 1
        return { receiverId: "accepted", systemEvent: event, status: "handled" }
      },
    },
    {
      id: () => "rejected",
      receive: async (event) => {
        rejectedCalls += 1
        if (reject) throw new Error("delivery failed")
        return { receiverId: "rejected", systemEvent: event, status: "handled" }
      },
    },
  ]
  try {
    assert.strictEqual(
      (await new Manager([monitor], receivers, state).trigger()).status,
      "failure"
    )
    assert.strictEqual(checkpoint, 100)
    assert.deepStrictEqual(pending, { fromBlock: 88, toBlock: 150 })
    latestBlock = 200
    reject = false
    assert.strictEqual(
      (await new Manager([monitor], receivers, state).trigger()).status,
      "success"
    )
    assert.strictEqual(checkpoint, 150)
    assert.strictEqual(pending, null)
    assert.strictEqual(acceptedCalls, 1)
    assert.strictEqual(rejectedCalls, 2)
  } finally {
    blocks.latestBlock = originalLatest
  }
})
