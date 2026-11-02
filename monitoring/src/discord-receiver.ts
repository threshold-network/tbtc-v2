import {
  BaseReceiver as BaseSystemEventReceiver,
  SystemEventType,
} from "./system-event"

import type {
  SystemEvent,
  ReceiverId as SystemEventReceiverId,
} from "./system-event"

export class DiscordReceiver extends BaseSystemEventReceiver {
  private readonly webhookUrl: string

  constructor(webhookUrl: string) {
    super()
    this.webhookUrl = webhookUrl
  }

  id(): SystemEventReceiverId {
    return "Discord"
  }

  isSupportedSystemEvent(systemEvent: SystemEvent): boolean {
    return systemEvent.type === SystemEventType.Informational
  }

  async handle(systemEvent: SystemEvent): Promise<void> {
    const fields = Object.entries(systemEvent.data).map((entry) => ({
      name: entry[0],
      value: entry[1],
    }))

    fields.push({ name: "block", value: `${systemEvent.block}` })

    const discordEmbeds = [
      {
        title: systemEvent.title,
        color: 0x003399, // Blue as everything is informational.
        fields,
      },
    ]

    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 30000)
    try {
      const response = await fetch(this.webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ embeds: discordEmbeds }),
        signal: controller.signal,
        redirect: "error",
      })
      // Discord normally replies with an empty 204. We do not need response
      // content, so cancel it instead of buffering an unbounded peer response.
      await response.body?.cancel()
      if (!response.ok) {
        throw new Error(`Discord webhook failed with status ${response.status}`)
      }
    } finally {
      clearTimeout(timer)
    }
  }
}
