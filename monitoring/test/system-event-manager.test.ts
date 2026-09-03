import assert from "assert"

import { Manager, SystemEventType } from "../src/system-event"

import { test } from "./test-runner"

import type {
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

test("Manager reports an error when no receivers are registered", async () => {
  const manager = new Manager([monitor], [], persistence({}))
  const report = await manager.check(100, 200)

  assert.strictEqual(report.errors.length, 1)
  assert.ok(report.errors[0].includes("no receivers registered"))
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
