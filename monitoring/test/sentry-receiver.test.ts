import assert from "assert"

import * as Sentry from "@sentry/node"

import { SentryReceiver } from "../src/sentry-receiver"
import { SystemEventType } from "../src/system-event"

import { test } from "./test-runner"

import type { SystemEvent } from "../src/system-event"

type ScopeStub = {
  setExtras: (extras: Record<string, string>) => void
  setExtra: (key: string, value: unknown) => void
  setLevel: (level: Sentry.SeverityLevel) => void
}

type MutableSentry = {
  captureMessage: (message: string) => string | undefined
  flush: (timeout?: number) => Promise<boolean>
  init: (options?: Sentry.NodeOptions) => void
  withScope: (callback: (scope: ScopeStub) => void) => void
}

const systemEvent: SystemEvent = {
  title: "wallet balance below threshold",
  type: SystemEventType.Warning,
  data: {
    wallet: "0x1234",
  },
  block: 100,
}

function stubSentry(overrides: Partial<MutableSentry>): () => void {
  const sentry = Sentry as unknown as MutableSentry
  const original = {
    captureMessage: sentry.captureMessage,
    flush: sentry.flush,
    init: sentry.init,
    withScope: sentry.withScope,
  }

  sentry.init = overrides.init ?? (() => undefined)
  sentry.withScope =
    overrides.withScope ??
    ((callback: (scope: ScopeStub) => void) =>
      callback({
        setExtras: () => undefined,
        setExtra: () => undefined,
        setLevel: () => undefined,
      }))
  sentry.captureMessage = overrides.captureMessage ?? (() => "event-id")
  sentry.flush = overrides.flush ?? (async () => true)

  return () => {
    sentry.captureMessage = original.captureMessage
    sentry.flush = original.flush
    sentry.init = original.init
    sentry.withScope = original.withScope
  }
}

test("SentryReceiver fails closed when Sentry rejects an event", async () => {
  const restore = stubSentry({
    captureMessage: () => undefined,
  })

  try {
    const receiver = new SentryReceiver("https://example.com/sentry")

    await assert.rejects(
      () => receiver.receive(systemEvent),
      /Sentry did not accept the system event/
    )
  } finally {
    restore()
  }
})

test("SentryReceiver fails closed when an event is not flushed", async () => {
  const restore = stubSentry({
    flush: async () => false,
  })

  try {
    const receiver = new SentryReceiver("https://example.com/sentry")

    await assert.rejects(
      () => receiver.receive(systemEvent),
      /Sentry event was not flushed/
    )
  } finally {
    restore()
  }
})
