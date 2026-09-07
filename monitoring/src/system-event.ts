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
      // Persist before checking or dispatching: a later end block could
      // erase a failed state-derived notification, even after a restart.
      // Persist retries too, in case a failed save left only an in-memory range.
      await this.persistence.updatePendingBlockRange(range)
      const { fromBlock, toBlock } = range

      const { systemEventsAcks, errors } = await this.check(fromBlock, toBlock)

      const handledSystemEventsAcks = systemEventsAcks.filter(
        (ack) => ack.status === "handled"
      )

      if (handledSystemEventsAcks.length !== 0) {
        try {
          const groupByReceiver = (
            group: Record<ReceiverId, SystemEvent[]>,
            ack: SystemEventAck
          ) => {
            const { receiverId, systemEvent } = ack
            // eslint-disable-next-line no-param-reassign
            group[receiverId] = group[receiverId] ?? []
            group[receiverId].push(systemEvent)
            return group
          }

          await this.persistence.storeHandledSystemEvents(
            handledSystemEventsAcks.reduce(groupByReceiver, {})
          )
        } catch (error) {
          errors.push(`cannot store handled system events: ${error}`)
        }
      }

      if (errors.length === 0) {
        try {
          await this.persistence.updateCheckpointBlock(toBlock)
        } catch (error) {
          errors.push(`cannot update checkpoint block: ${error}`)
        }
      }

      if (errors.length === 0) {
        try {
          // Clear only after acknowledgments and the checkpoint are durable.
          // A failure here safely replays the same range with deduplication.
          await this.persistence.updatePendingBlockRange(null)
        } catch (error) {
          errors.push(`cannot clear pending block range: ${error}`)
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

    const handledSystemEvents = await this.persistence.handledSystemEvents()

    const dispatches = await Promise.allSettled(
      this.receivers
        .map((r) => Deduplicator.wrap(r, handledSystemEvents[r.id()] ?? []))
        .flatMap((r) => systemEvents.map((se) => r.receive(se)))
    )

    const systemEventsAcks: SystemEventAck[] = []

    dispatches.forEach((result) => {
      if (result.status === "fulfilled") {
        systemEventsAcks.push(result.value)
      } else {
        errors.push(`cannot dispatch system event: ${result.reason}`)
      }
    })

    const dispatchedSystemEventKeys = new Set(
      systemEventsAcks
        .filter((ack) => ack.status === "handled" || ack.status === "duplicate")
        .map((ack) => Deduplicator.systemEventKey(ack.systemEvent))
    )

    // Index ack statuses by event key to detect partial-deployment cases.
    const ackStatusesByKey = new Map<string, Set<SystemEventAck["status"]>>()
    systemEventsAcks.forEach((ack) => {
      const key = Deduplicator.systemEventKey(ack.systemEvent)
      const statuses =
        ackStatusesByKey.get(key) ?? new Set<SystemEventAck["status"]>()
      statuses.add(ack.status)
      ackStatusesByKey.set(key, statuses)
    })

    systemEvents.forEach((systemEvent) => {
      const key = Deduplicator.systemEventKey(systemEvent)
      if (dispatchedSystemEventKeys.has(key)) return
      const statuses = ackStatusesByKey.get(key) ?? new Set()
      // Skip if every receiver ignored this event (no receiver is configured
      // for this event type -- valid in partial-receiver deployments) or if all
      // dispatches were rejected and already recorded as errors above.
      if (
        statuses.size === 0 ||
        (statuses.size === 1 && statuses.has("ignored"))
      )
        return
      errors.push(
        `system event was not handled by any receiver: ${systemEvent.title}`
      )
    })

    return {
      systemEventsAcks,
      errors,
    }
  }
}
