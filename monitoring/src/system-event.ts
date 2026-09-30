// eslint-disable-next-line max-classes-per-file
import { blocks } from "./blocks"

export enum SystemEventType {
  Informational = "informational",
  Warning = "warning",
  Critical = "critical",
}

export interface SystemEvent {
  title: string
  type: SystemEventType
  data: Record<string, string>
  block: number
}

export interface Monitor {
  check: (fromBlock: number, toBlock: number) => Promise<SystemEvent[]>
}

export type ReceiverId = string

export interface SystemEventAck {
  receiverId: ReceiverId
  systemEvent: SystemEvent
  status: "handled" | "ignored" | "duplicate"
}

export interface Receiver {
  id: () => ReceiverId
  receive: (systemEvent: SystemEvent) => Promise<SystemEventAck>
}

export abstract class BaseReceiver implements Receiver {
  abstract id(): ReceiverId

  abstract isSupportedSystemEvent(systemEvent: SystemEvent): boolean

  abstract handle(systemEvent: SystemEvent): Promise<void>

  async receive(systemEvent: SystemEvent): Promise<SystemEventAck> {
    if (!this.isSupportedSystemEvent(systemEvent)) {
      return {
        receiverId: this.id(),
        systemEvent,
        status: "ignored",
      }
    }

    await this.handle(systemEvent)

    return {
      receiverId: this.id(),
      systemEvent,
      status: "handled",
    }
  }
}

class Deduplicator implements Receiver {
  private receiver: Receiver

  private readonly cache: Record<string, boolean> // system event key -> boolean

  private constructor(receiver: Receiver, cache: Record<string, boolean>) {
    this.receiver = receiver
    this.cache = cache
  }

  static systemEventKey(systemEvent: SystemEvent): string {
    return JSON.stringify(systemEvent)
  }

  static wrap(
    receiver: Receiver,
    handledSystemEvents: SystemEvent[]
  ): Deduplicator {
    const cache = handledSystemEvents.reduce(
      (group: Record<string, boolean>, systemEvent: SystemEvent) => {
        // eslint-disable-next-line no-param-reassign
        group[Deduplicator.systemEventKey(systemEvent)] = true
        return group
      },
      {}
    )

    return new Deduplicator(receiver, cache)
  }

  id(): ReceiverId {
    return this.receiver.id()
  }

  async receive(systemEvent: SystemEvent): Promise<SystemEventAck> {
    if (this.cache[Deduplicator.systemEventKey(systemEvent)]) {
      return {
        receiverId: this.id(),
        systemEvent,
        status: "duplicate",
      }
    }

    return this.receiver.receive(systemEvent)
  }
}

export interface BlockRange {
  fromBlock: number
  toBlock: number
}

export interface Persistence {
  checkpointBlock: () => Promise<number>

  updateCheckpointBlock: (block: number) => Promise<void>

  pendingBlockRange: () => Promise<BlockRange | null>

  updatePendingBlockRange: (range: BlockRange | null) => Promise<void>

  pendingSystemEvents: () => Promise<Record<ReceiverId, SystemEvent[]>>

  updatePendingSystemEvents: (
    systemEvents: Record<ReceiverId, SystemEvent[]>
  ) => Promise<void>

  handledSystemEvents: () => Promise<Record<ReceiverId, SystemEvent[]>>

  storeHandledSystemEvents: (
    systemEvents: Record<ReceiverId, SystemEvent[]>
  ) => Promise<void>
}

export interface ManagerReport {
  fromBlock?: number
  toBlock?: number
  status: "success" | "failure"
  errors: string[]
}

// Our expectation on how deep can chain reorganization be.
const reorgDepthBlocks = 12

// Limit a single catch-up pass to keep stale checkpoints from producing
// unbounded node queries and alert fanout.
const maxBlockRange = 10000

export class Manager {
  private monitors: Monitor[]

  private receivers: Receiver[]

  private persistence: Persistence

  constructor(
    monitors: Monitor[],
    receivers: Receiver[],
    persistence: Persistence
  ) {
    this.monitors = monitors
    this.receivers = receivers
    this.persistence = persistence
  }

  async trigger(): Promise<ManagerReport> {
    try {
      let range = await this.persistence.pendingBlockRange()
      if (!range) {
        const checkpointBlock = await this.persistence.checkpointBlock()
        const latestBlock = await blocks.latestBlock()

        const validCheckpoint =
          checkpointBlock > 0 && checkpointBlock < latestBlock

        let fromBlock = validCheckpoint ? checkpointBlock : latestBlock

        // Adjust the fromBlock using the reorgDepthBlocks factor to cover
        // potential chain reorgs.
        fromBlock =
          fromBlock - reorgDepthBlocks > 0 ? fromBlock - reorgDepthBlocks : 0

        range = {
          fromBlock,
          toBlock: Math.min(latestBlock, fromBlock + maxBlockRange),
        }
      }
      // Keep historical bounds until the scan results are durably captured.
      // Persist retries too, in case a failed save left only an in-memory range.
      await this.persistence.updatePendingBlockRange(range)
      const { fromBlock, toBlock } = range

      const { scanSucceeded, errors } = await this.check(fromBlock, toBlock)

      // Once every monitor's events are durably queued, receiver failures must
      // not hold the scan checkpoint behind newer events for healthy receivers.
      if (scanSucceeded) {
        try {
          await this.persistence.updateCheckpointBlock(toBlock)
          await this.persistence.updatePendingBlockRange(null)
        } catch (error) {
          errors.push(`cannot complete scanned block range: ${error}`)
        }
      }

      return {
        fromBlock,
        toBlock,
        status: errors.length === 0 ? "success" : "failure",
        errors,
      }
    } catch (error) {
      return {
        status: "failure",
        errors: [`${error}`],
      }
    }
  }

  async check(
    fromBlock: number,
    toBlock: number
  ): Promise<{
    systemEventsAcks: SystemEventAck[]
    scanSucceeded: boolean
    errors: string[]
  }> {
    const systemEvents: SystemEvent[] = []
    const errors: string[] = []

    const checks = await Promise.allSettled(
      this.monitors.map((m) => m.check(fromBlock, toBlock))
    )

    checks.forEach((result) => {
      if (result.status === "fulfilled") {
        systemEvents.push(...result.value)
      } else {
        errors.push(`cannot check system events monitor: ${result.reason}`)
      }
    })
    const scanSucceeded = errors.length === 0

    const [handledSystemEvents, pendingSystemEvents] = await Promise.all([
      this.persistence.handledSystemEvents(),
      this.persistence.pendingSystemEvents(),
    ])
    const queued: Record<ReceiverId, SystemEvent[]> = { ...pendingSystemEvents }
    this.receivers.forEach((receiver) => {
      const id = receiver.id()
      const uniqueEvents = new Map(
        [...(queued[id] ?? []), ...systemEvents].map((event) => [
          Deduplicator.systemEventKey(event),
          event,
        ])
      )
      queued[id] = [...uniqueEvents.values()]
    })

    // Capture payloads per receiver before any delivery or checkpoint update.
    // In particular, an expiration must survive a later proof or process exit.
    // Entries for temporarily unconfigured receivers remain in this outbox.
    await this.persistence.updatePendingSystemEvents(queued)

    const deliveries = this.receivers.flatMap((receiver) => {
      const id = receiver.id()
      const deduplicator = Deduplicator.wrap(
        receiver,
        handledSystemEvents[id] ?? []
      )
      return (queued[id] ?? []).map((systemEvent) => ({
        receiverId: id,
        systemEvent,
        receive: () => deduplicator.receive(systemEvent),
      }))
    })
    const dispatches = await Promise.allSettled(
      deliveries.map((delivery) => delivery.receive())
    )

    const systemEventsAcks: SystemEventAck[] = []
    const remaining: Record<ReceiverId, SystemEvent[]> = { ...queued }
    this.receivers.forEach((receiver) => {
      delete remaining[receiver.id()]
    })
    dispatches.forEach((result, index) => {
      const { receiverId, systemEvent } = deliveries[index]
      if (result.status === "fulfilled") {
        systemEventsAcks.push(result.value)
      } else {
        remaining[receiverId] = remaining[receiverId] ?? []
        remaining[receiverId].push(systemEvent)
        errors.push(
          `cannot dispatch system event to ${receiverId}: ${result.reason}`
        )
      }
    })
    Object.keys(remaining).forEach((id) => {
      if (
        remaining[id].length > 0 &&
        !this.receivers.some((r) => r.id() === id)
      ) {
        errors.push(`pending system events have no configured receiver: ${id}`)
      }
    })

    const handled: Record<ReceiverId, SystemEvent[]> = {}
    systemEventsAcks.forEach((ack) => {
      if (ack.status !== "handled") return
      handled[ack.receiverId] = handled[ack.receiverId] ?? []
      handled[ack.receiverId].push(ack.systemEvent)
    })
    try {
      if (Object.keys(handled).length > 0) {
        await this.persistence.storeHandledSystemEvents(handled)
      }
      // Remove acknowledged/ignored events only after handled history is saved.
      // If either write fails, the durable pre-dispatch outbox permits replay.
      await this.persistence.updatePendingSystemEvents(remaining)
    } catch (error) {
      errors.push(`cannot store system event delivery results: ${error}`)
    }

    return { systemEventsAcks, scanSucceeded, errors }
  }
}
