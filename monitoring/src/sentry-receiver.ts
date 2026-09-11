import * as crypto from "crypto"

import * as Sentry from "@sentry/node"

import {
  BaseReceiver as BaseSystemEventReceiver,
  SystemEventType,
} from "./system-event"

import type {
  SystemEvent,
  ReceiverId as SystemEventReceiverId,
} from "./system-event"

export class SentryReceiver extends BaseSystemEventReceiver {
  constructor(dsn: string) {
    super()

    Sentry.init({ dsn })
  }

  id(): SystemEventReceiverId {
    return "Sentry"
  }

  isSupportedSystemEvent(systemEvent: SystemEvent): boolean {
    return (
      systemEvent.type === SystemEventType.Warning ||
      systemEvent.type === SystemEventType.Critical
    )
  }

  async handle(systemEvent: SystemEvent): Promise<void> {
    let eventId: string | undefined

    Sentry.withScope((scope) => {
      scope.setExtras(systemEvent.data)
      scope.setExtra("block", systemEvent.block)
      scope.setLevel(this.resolveSeverityLevel(systemEvent.type))

      // Sentry groups events by title. In order to have them separated, we
      // must ensure the title is unique.
      const hash = crypto
        .createHash("sha256")
        .update(JSON.stringify(systemEvent))
        .digest("base64")

      eventId = Sentry.captureMessage(`${systemEvent.title} [${hash}]`)
    })

    if (!eventId) {
      throw new Error("Sentry did not accept the system event")
    }

    if (!(await Sentry.flush(2000))) {
      throw new Error("Sentry event was not flushed")
    }
  }

  private resolveSeverityLevel(
    systemEventType: SystemEventType
  ): Sentry.SeverityLevel {
    switch (systemEventType) {
      case SystemEventType.Warning: {
        return "warning"
      }
      case SystemEventType.Critical: {
        return "fatal"
      }
      default: {
        throw new Error(`unsupported system event type: ${systemEventType}`)
      }
    }
  }
}
