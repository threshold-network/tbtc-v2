import { Config, JsonDB } from "node-json-db"

import { context } from "./context"

import type { SupplyMonitorPersistence } from "./supply-monitor"
import type {
  BlockRange,
  Persistence as SystemEventPersistence,
  ReceiverId as SystemEventReceiverId,
  SystemEvent,
} from "./system-event"

const maxHandledSystemEventsPerReceiver = 5000

export class SystemEventFilePersistence implements SystemEventPersistence {
  private readonly checkpointBlockPath = "/checkpointBlock"

  private readonly handledSystemEventsPath = "/handledSystemEvents"

  private readonly pendingBlockRangePath = "/pendingBlockRange"

  private readonly pendingSystemEventsPath = "/pendingSystemEvents"

  private db: JsonDB

  constructor() {
    this.db = new JsonDB(
      new Config(`${context.dataDirPath}/db.json`, true, true, "/")
    )
  }

  async checkpointBlock(): Promise<number> {
    if (!(await this.db.exists(this.checkpointBlockPath))) {
      return 0
    }

    return this.db.getObject<number>(this.checkpointBlockPath)
  }

  async updateCheckpointBlock(block: number): Promise<void> {
    await this.db.push(this.checkpointBlockPath, block)
  }

  async pendingBlockRange(): Promise<BlockRange | null> {
    // Existing data directories have no pending range until their first run.
    if (!(await this.db.exists(this.pendingBlockRangePath))) {
      return null
    }

    return this.db.getObject<BlockRange | null>(this.pendingBlockRangePath)
  }

  async updatePendingBlockRange(range: BlockRange | null): Promise<void> {
    await this.db.push(this.pendingBlockRangePath, range)
  }

  async pendingSystemEvents(): Promise<
    Record<SystemEventReceiverId, SystemEvent[]>
  > {
    if (!(await this.db.exists(this.pendingSystemEventsPath))) {
      return {}
    }
    return this.db.getObject<Record<SystemEventReceiverId, SystemEvent[]>>(
      this.pendingSystemEventsPath
    )
  }

  async updatePendingSystemEvents(
    systemEvents: Record<SystemEventReceiverId, SystemEvent[]>
  ): Promise<void> {
    // Pending notifications must not be truncated like the handled-event cache.
    await this.db.push(this.pendingSystemEventsPath, systemEvents)
  }

  async handledSystemEvents(): Promise<
    Record<SystemEventReceiverId, SystemEvent[]>
  > {
    if (!(await this.db.exists(this.handledSystemEventsPath))) {
      return {}
    }

    return this.db.getObject<Record<SystemEventReceiverId, SystemEvent[]>>(
      this.handledSystemEventsPath
    )
  }

  async storeHandledSystemEvents(
    systemEvents: Record<SystemEventReceiverId, SystemEvent[]>
  ): Promise<void> {
    const handledSystemEvents = await this.handledSystemEvents()

    Object.keys(systemEvents).forEach((receiverId) => {
      handledSystemEvents[receiverId] = handledSystemEvents[receiverId] ?? []
      handledSystemEvents[receiverId].push(...systemEvents[receiverId])
      handledSystemEvents[receiverId] = handledSystemEvents[receiverId].slice(
        -maxHandledSystemEventsPerReceiver
      )
    })

    await this.db.push(this.handledSystemEventsPath, handledSystemEvents)
  }
}

export class SupplyMonitorFilePersistence implements SupplyMonitorPersistence {
  private readonly lastHighTotalSupplyChangeBlockPath =
    "/lastHighTotalSupplyChangeBlock"

  private db: JsonDB

  constructor() {
    this.db = new JsonDB(
      new Config(
        `${context.dataDirPath}/supply-monitor-db.json`,
        true,
        true,
        "/"
      )
    )
  }

  async lastHighTotalSupplyChangeBlock(): Promise<number> {
    if (!(await this.db.exists(this.lastHighTotalSupplyChangeBlockPath))) {
      return 0
    }

    return this.db.getObject<number>(this.lastHighTotalSupplyChangeBlockPath)
  }

  async updateLastHighTotalSupplyChangeBlock(block: number): Promise<void> {
    await this.db.push(this.lastHighTotalSupplyChangeBlockPath, block)
  }
}
