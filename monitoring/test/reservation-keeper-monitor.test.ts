import http from "http"
import assert from "assert"

import {
  ReservationKeeperMonitor,
  reservationKeeperMetricNames,
} from "../src/reservation-keeper-monitor"
import { Manager, SystemEventType } from "../src/system-event"

import { test } from "./test-runner"

import type { Persistence, Receiver, SystemEvent } from "../src/system-event"

// Node 22 provides Promise.withResolvers; this TypeScript lib does not type it.
declare global {
  interface PromiseConstructor {
    withResolvers<T = unknown>(): {
      promise: Promise<T>
      resolve: (value: T | PromiseLike<T>) => void
      reject: (reason?: unknown) => void
    }
  }
}

const metricsUrl = "http://keeper-metrics.invalid/metrics"
// Anchor the chain block time to the current wall clock so the fresh
// observation timestamp stays within the default 30-minute max age.
const chainTime = Math.floor(Date.now() / 1000)
const freshTimestamp = chainTime - 60

const countMetricNames = [
  reservationKeeperMetricNames.lateProofAtRiskCount,
  reservationKeeperMetricNames.noEligibleTargetCount,
  reservationKeeperMetricNames.vaultFeeDebtSat,
  reservationKeeperMetricNames.unrequestedDepositDeadlineAtRiskCount,
]

function sampleMetrics(
  values: Record<string, string> = {},
  options: { withTimestamp?: boolean; timestamp?: string } = {}
): string {
  const lines = countMetricNames.map((name) => `${name} ${values[name] ?? "0"}`)
  if (options.withTimestamp !== false) {
    lines.push(
      `${reservationKeeperMetricNames.observationTimestamp} ${
        options.timestamp ?? freshTimestamp
      }`
    )
  }
  return `${lines.join("\n")}\n`
}

function monitorFrom(
  text: string,
  options: {
    chainTime?: number
    maxAge?: number
    latestTime?: number
  } = {}
): ReservationKeeperMonitor {
  const { latestTime } = options
  const latestOptions =
    latestTime === undefined
      ? {}
      : { latestBlockTimestamp: async () => latestTime }
  return new ReservationKeeperMonitor(metricsUrl, {
    observationMaxAgeSeconds: options.maxAge ?? 1800,
    blockTimestamp: async () => options.chainTime ?? chainTime,
    fetcher: async () => text,
    // latestBlockTimestamp is threaded only when supplied so the test file
    // stays compatible while the option is rolled out.
    ...latestOptions,
  })
}

function failingMonitor(
  error: Error,
  options: { chainTime?: number; maxAge?: number } = {}
): ReservationKeeperMonitor {
  return new ReservationKeeperMonitor(metricsUrl, {
    observationMaxAgeSeconds: options.maxAge ?? 1800,
    blockTimestamp: async () => options.chainTime ?? 2000,
    fetcher: async () => {
      throw error
    },
  })
}

function assertNoUrlLeak(events: SystemEvent[]): void {
  assert.ok(!JSON.stringify(events).includes(metricsUrl))
}

function inMemoryPersistence(): Persistence {
  let pendingEvents: Record<string, SystemEvent[]> = {}
  return {
    checkpointBlock: async () => 0,
    updateCheckpointBlock: async () => undefined,
    pendingBlockRange: async () => null,
    updatePendingBlockRange: async () => undefined,
    pendingSystemEvents: async () => pendingEvents,
    updatePendingSystemEvents: async (events) => {
      pendingEvents = events
    },
    handledSystemEvents: async () => ({}),
    storeHandledSystemEvents: async () => undefined,
  }
}

test("clean reservation keeper metrics produce no events", async () => {
  const events = await monitorFrom(sampleMetrics()).check(100, 200)

  assert.deepStrictEqual(events, [])
})

test("an at-risk acceptance generation escalates to a critical alert", async () => {
  const events = await monitorFrom(
    sampleMetrics({ [reservationKeeperMetricNames.lateProofAtRiskCount]: "3" })
  ).check(100, 200)

  assert.strictEqual(events.length, 1)
  assert.strictEqual(events[0].type, SystemEventType.Critical)
  assert.strictEqual(
    events[0].title,
    "Reservation keeper late acceptance proofs at risk"
  )
  assert.strictEqual(events[0].data.lateProofAtRiskCount, "3")
  assert.strictEqual(events[0].block, 200)
})

test("a moving-funds wallet without an eligible re-anchor target escalates", async () => {
  const events = await monitorFrom(
    sampleMetrics({ [reservationKeeperMetricNames.noEligibleTargetCount]: "2" })
  ).check(100, 200)

  assert.strictEqual(events.length, 1)
  assert.strictEqual(events[0].type, SystemEventType.Critical)
  assert.strictEqual(
    events[0].title,
    "Reservation keeper re-anchor has no eligible target"
  )
  assert.strictEqual(events[0].data.noEligibleTargetCount, "2")
})

test("a vault fee debt raises a warning alert", async () => {
  const events = await monitorFrom(
    sampleMetrics({ [reservationKeeperMetricNames.vaultFeeDebtSat]: "1234" })
  ).check(100, 200)

  assert.strictEqual(events.length, 1)
  assert.strictEqual(events[0].type, SystemEventType.Warning)
  assert.strictEqual(events[0].title, "Reservation keeper vault fee debt")
  assert.strictEqual(events[0].data.vaultFeeDebtSat, "1234")
})

test("an unrequested deposit near its request deadline raises a warning", async () => {
  const events = await monitorFrom(
    sampleMetrics({
      [reservationKeeperMetricNames.unrequestedDepositDeadlineAtRiskCount]: "1",
    })
  ).check(100, 200)

  assert.strictEqual(events.length, 1)
  assert.strictEqual(events[0].type, SystemEventType.Warning)
  assert.strictEqual(
    events[0].title,
    "Reservation keeper unrequested deposit deadline at risk"
  )
  assert.strictEqual(events[0].data.unrequestedDepositDeadlineAtRiskCount, "1")
})

test("every at-risk signal produces its own event", async () => {
  const events = await monitorFrom(
    sampleMetrics({
      [reservationKeeperMetricNames.lateProofAtRiskCount]: "1",
      [reservationKeeperMetricNames.noEligibleTargetCount]: "1",
      [reservationKeeperMetricNames.vaultFeeDebtSat]: "5",
      [reservationKeeperMetricNames.unrequestedDepositDeadlineAtRiskCount]: "1",
    })
  ).check(100, 200)

  assert.strictEqual(events.length, 4)
  assert.deepStrictEqual(
    events.map((event) => event.type),
    [
      SystemEventType.Critical,
      SystemEventType.Critical,
      SystemEventType.Warning,
      SystemEventType.Warning,
    ]
  )
})

test("labeled samples and unrelated metrics parse without extra alerts", async () => {
  const metricName = reservationKeeperMetricNames.vaultFeeDebtSat
  const text = `${sampleMetrics({
    [metricName]: "7",
  }).trimEnd()}\nreservation_keeper_something_else 1\n`
  const events = await monitorFrom(
    text.replace(metricName, `${metricName}{wallet="0xabcd"}`)
  ).check(100, 200)

  assert.strictEqual(events.length, 1)
  assert.strictEqual(events[0].data.vaultFeeDebtSat, "7")
})

test("a missing observation timestamp is a critical stale alert", async () => {
  const events = await monitorFrom(
    sampleMetrics({}, { withTimestamp: false })
  ).check(100, 200)

  assert.strictEqual(events.length, 1)
  assert.strictEqual(events[0].type, SystemEventType.Critical)
  assert.strictEqual(events[0].title, "Reservation keeper metrics stale")
  assert.ok(
    events[0].data.reason.includes(
      reservationKeeperMetricNames.observationTimestamp
    )
  )
  assertNoUrlLeak(events)
})

test("an observation at exactly the max age is still fresh", async () => {
  const events = await monitorFrom(
    sampleMetrics({}, { timestamp: String(chainTime - 600) }),
    { maxAge: 600 }
  ).check(100, 200)

  assert.deepStrictEqual(events, [])
})

test("an observation older than the max age is a critical stale alert", async () => {
  const events = await monitorFrom(
    sampleMetrics({}, { timestamp: String(chainTime - 601) }),
    { maxAge: 600 }
  ).check(100, 200)

  assert.strictEqual(events.length, 1)
  assert.strictEqual(events[0].type, SystemEventType.Critical)
  assert.strictEqual(events[0].title, "Reservation keeper metrics stale")
  assert.strictEqual(
    events[0].data.observationTimestamp,
    String(chainTime - 601)
  )
  assert.strictEqual(events[0].data.chainBlockTime, String(chainTime))
  assertNoUrlLeak(events)
})

test("a catch-up scan of an old window does not flag a healthy keeper", async () => {
  // The Manager may scan an old toBlock on catch-up while the keeper
  // observes against the chain head, so its timestamp is current.
  const events = await monitorFrom(
    sampleMetrics({}, { timestamp: String(chainTime) }),
    { chainTime: chainTime - 7200, latestTime: chainTime }
  ).check(100, 200)

  assert.deepStrictEqual(events, [])
})

test("a stale keeper is flagged even when the scanned window is old", async () => {
  const events = await monitorFrom(
    sampleMetrics({}, { timestamp: String(chainTime - 7200) }),
    { chainTime: chainTime - 7200, latestTime: chainTime }
  ).check(100, 200)

  assert.strictEqual(events.length, 1)
  assert.strictEqual(events[0].type, SystemEventType.Critical)
  assert.strictEqual(events[0].title, "Reservation keeper metrics stale")
  assertNoUrlLeak(events)
})

test("an observation up to the max age ahead of the latest block time is fresh", async () => {
  // The keeper's RPC may lead the monitor's RPC; tolerate up to the max age.
  const events = await monitorFrom(
    sampleMetrics({}, { timestamp: String(chainTime + 600) }),
    { latestTime: chainTime, maxAge: 600 }
  ).check(100, 200)

  assert.deepStrictEqual(events, [])
})

test("an observation more than the max age ahead of the latest block time is a critical stale alert", async () => {
  const events = await monitorFrom(
    sampleMetrics({}, { timestamp: String(chainTime + 601) }),
    { maxAge: 600 }
  ).check(100, 200)

  assert.strictEqual(events.length, 1)
  assert.strictEqual(events[0].type, SystemEventType.Critical)
  assert.strictEqual(events[0].title, "Reservation keeper metrics stale")
  assertNoUrlLeak(events)
})

test("malformed metric values are a critical stale alert without the URL", async () => {
  const text = sampleMetrics().replace("0\n", "not-a-number\n")
  const events = await monitorFrom(text).check(100, 200)

  assert.strictEqual(events.length, 1)
  assert.strictEqual(events[0].type, SystemEventType.Critical)
  assert.strictEqual(events[0].title, "Reservation keeper metrics stale")
  assert.ok(events[0].data.reason.includes("malformed"))
  assertNoUrlLeak(events)
})

test("a failed endpoint is a critical stale alert without the URL", async () => {
  const events = await failingMonitor(
    new Error(`GET ${metricsUrl} failed: request timed out`)
  ).check(100, 200)

  assert.strictEqual(events.length, 1)
  assert.strictEqual(events[0].type, SystemEventType.Critical)
  assert.strictEqual(events[0].title, "Reservation keeper metrics stale")
  assert.strictEqual(events[0].data.reason, "metrics endpoint unavailable")
  assertNoUrlLeak(events)
})

test("reservation keeper alerts reach a receiver through the Manager", async () => {
  const body = sampleMetrics({
    [reservationKeeperMetricNames.vaultFeeDebtSat]: "42",
  })
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "Content-Type": "text/plain" })
    response.end(body)
  })
  const { promise: listening, resolve, reject } = Promise.withResolvers<void>()
  server.on("error", reject)
  server.listen(0, "127.0.0.1", resolve)
  await listening

  const rawAddress = server.address()
  if (rawAddress === null || typeof rawAddress === "string") {
    throw new Error("metrics server address unavailable")
  }

  try {
    const monitor = new ReservationKeeperMonitor(
      `http://127.0.0.1:${rawAddress.port}/metrics`,
      {
        observationMaxAgeSeconds: 1800,
        blockTimestamp: async () => chainTime,
      }
    )
    const received: SystemEvent[] = []
    const receiver: Receiver = {
      id: () => "Memory",
      receive: async (event) => {
        received.push(event)
        return { receiverId: "Memory", systemEvent: event, status: "handled" }
      },
    }

    const manager = new Manager([monitor], [receiver], inMemoryPersistence())
    const report = await manager.check(100, 200)

    assert.deepStrictEqual(report.errors, [])
    assert.strictEqual(received.length, 1)
    assert.strictEqual(received[0].type, SystemEventType.Warning)
    assert.strictEqual(received[0].data.vaultFeeDebtSat, "42")
  } finally {
    const { promise: closed, resolve: closeResolve } =
      Promise.withResolvers<void>()
    server.close(() => closeResolve(undefined))
    await closed
  }
})
