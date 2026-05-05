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

test("Manager reports a system event ignored by every receiver", async () => {
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

  assert.deepStrictEqual(report.errors, [
    "system event was not handled by any receiver: wallet is moving funds",
  ])
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
