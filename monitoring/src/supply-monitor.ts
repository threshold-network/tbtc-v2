import { SystemEventType } from "./system-event"

import type { BigNumber } from "ethers"
import type { TBTCToken } from "@keep-network/tbtc-v2.ts/core"
import type { Monitor as SystemEventMonitor, SystemEvent } from "./system-event"

// The block span the supply change is checked for. It is 12 hours expressed
// in ETH blocks, assuming 12 seconds per block on average.
const totalSupplyBlockSpan = (12 * 60 * 60) / 12

const totalSupplyChangeThreshold = 10 // 10%

const HighTotalSupplyChange = (
  difference: BigNumber,
  change: BigNumber | undefined,
  threshold: number,
  referenceBlock: number,
  currentBlock: number
): SystemEvent => ({
  title: "High TBTC token total supply change",
  type: SystemEventType.Critical,
  data:
    change === undefined
      ? {
          change: "undefined (zero reference supply)",
          threshold: "not applicable (zero reference supply)",
          referenceBlock: referenceBlock.toString(),
          referenceSupply: "0",
          supplyDifferenceBaseUnits: difference.toString(),
        }
      : {
          change: `${difference.gte(0) ? "+" : "-"}${change.toString()}%`,
          threshold: `${threshold}%`,
          referenceBlock: referenceBlock.toString(),
        },
  block: currentBlock,
})

export interface SupplyMonitorPersistence {
  // Returns the end block of the check when the alert of the high total
  // supply change was triggered the last time. If the alert was never
  // triggered, this is 0.
  lastHighTotalSupplyChangeBlock: () => Promise<number>
  // Once a high total supply change alert is triggered, this function is
  // used to update the last alert block using the end block of the current
  // check.
  updateLastHighTotalSupplyChangeBlock: (block: number) => Promise<void>
}

export class SupplyMonitor implements SystemEventMonitor {
  private tbtcToken: TBTCToken

  private persistence: SupplyMonitorPersistence

  constructor(tbtcToken: TBTCToken, persistence: SupplyMonitorPersistence) {
    this.tbtcToken = tbtcToken
    this.persistence = persistence
  }

  async check(fromBlock: number, toBlock: number): Promise<SystemEvent[]> {
    // eslint-disable-next-line no-console
    console.log("running supply monitor check")

    // By default, the supply change is checked between the current and
    // reference blocks.
    const currentBlock = toBlock
    // For this particular monitor, the fromBlock is ignored and referenceBlock
    // replaces it.
    let referenceBlock =
      currentBlock - totalSupplyBlockSpan > 0
        ? currentBlock - totalSupplyBlockSpan
        : 0
    let threshold = totalSupplyChangeThreshold

    // Check the default reference block against the last high total supply change
    // event block. If the event already occurred in the checked block window,
    // the monitor uses the event block as reference in order to not produce
    // a duplicated event. Since the checked window is shorter, the threshold
    // is reduced by half.
    //
    // Example of usual case block widow assuming current block is 10000,
    // reference block is 10000 - 3600 = 6400, and last event occurred at block
    // 2000 before the reference block:
    // | --- 2000 -------- 6400 ------ 10000
    //                      ^            ^
    // Example of special case block window assuming current block is 10000,
    // reference block is 10000 - 3600 = 6400, and last event occurred at block
    // 8500 after the reference block:
    // | ----------- 6400 --- 8500 -- 10000
    //                         ^        ^
    const lastEventBlock =
      await this.persistence.lastHighTotalSupplyChangeBlock()
    if (lastEventBlock > referenceBlock) {
      referenceBlock = lastEventBlock
      threshold = totalSupplyChangeThreshold / 2
    }

    const referenceSupply = await this.tbtcToken.totalSupply(referenceBlock)
    const currentSupply = await this.tbtcToken.totalSupply(currentBlock)

    const difference = currentSupply.sub(referenceSupply)
    // There is a precision loss here, but it is acceptable as long as the
    // threshold is at least 1%.
    const change = referenceSupply.isZero()
      ? undefined
      : difference.abs().mul(100).div(referenceSupply)

    const systemEvents: SystemEvent[] = []

    // Check >= to catch cases when the change was bigger than threshold by
    // the decimal part but was rounded down to an integer.
    if (change === undefined ? !difference.isZero() : change.gte(threshold)) {
      systemEvents.push(
        HighTotalSupplyChange(
          difference,
          change,
          threshold,
          referenceBlock,
          currentBlock
        )
      )

      await this.persistence.updateLastHighTotalSupplyChangeBlock(currentBlock)
    }

    // eslint-disable-next-line no-console
    console.log("completed supply monitor check")

    return systemEvents
  }
}
