import { BigNumber } from "ethers"

import { SystemEventType } from "./system-event"
import { context } from "./context"
import { createBtcTxUrl, createEthTxUrl } from "./block-explorer"

import type { SystemEvent, Monitor as SystemEventMonitor } from "./system-event"
import type {
  Bridge,
  DepositRevealedEvent as DepositRevealedChainEvent,
} from "@keep-network/tbtc-v2.ts/core"

export const satsToRoundedBTC = (sats: BigNumber): string =>
  (sats.div(BigNumber.from(1e6)).toNumber() / 100).toFixed(2)

const DepositRevealed = (
  chainEvent: DepositRevealedChainEvent
): SystemEvent => {
  const btcFundingTxHashURL = createBtcTxUrl(chainEvent.fundingTxHash)
  const ethRevealTxHashURL = createEthTxUrl(chainEvent.transactionHash)

  return {
    title: "Deposit revealed",
    type: SystemEventType.Informational,
    data: {
      btcFundingTxHash: chainEvent.fundingTxHash.toString(),
      btcFundingTxHashURL,
      btcFundingOutputIndex: chainEvent.fundingOutputIndex.toString(),
      amountBTC: satsToRoundedBTC(chainEvent.amount),
      ethRevealTxHash: chainEvent.transactionHash.toPrefixedString(),
      ethRevealTxHashURL,
    },
    block: chainEvent.blockNumber,
  }
}

const LargeDepositRevealed = (
  chainEvent: DepositRevealedChainEvent
): SystemEvent => {
  const btcFundingTxHashURL = createBtcTxUrl(chainEvent.fundingTxHash)
  const ethRevealTxHashURL = createEthTxUrl(chainEvent.transactionHash)

  return {
    title: "Large deposit revealed",
    type: SystemEventType.Warning,
    data: {
      btcFundingTxHash: chainEvent.fundingTxHash.toString(),
      btcFundingTxHashURL,
      btcFundingOutputIndex: chainEvent.fundingOutputIndex.toString(),
      amountBTC: satsToRoundedBTC(chainEvent.amount),
      ethRevealTxHash: chainEvent.transactionHash.toPrefixedString(),
      ethRevealTxHashURL,
    },
    block: chainEvent.blockNumber,
  }
}

export class DepositMonitor implements SystemEventMonitor {
  private bridge: Bridge

  constructor(bridge: Bridge) {
    this.bridge = bridge
  }

  async check(fromBlock: number, toBlock: number): Promise<SystemEvent[]> {
    // eslint-disable-next-line no-console
    console.log("running deposit monitor check")

    const chainEvents = await this.bridge.getDepositRevealedEvents({
      fromBlock,
      toBlock,
    })

    const systemEvents: SystemEvent[] = []

    // eslint-disable-next-line no-plusplus
    for (let i = 0; i < chainEvents.length; i++) {
      const chainEvent = chainEvents[i]

      systemEvents.push(DepositRevealed(chainEvent))

      if (
        chainEvent.amount.gt(BigNumber.from(context.largeDepositThresholdSat))
      ) {
        systemEvents.push(LargeDepositRevealed(chainEvent))
      }
    }

    // eslint-disable-next-line no-console
    console.log("completed deposit monitor check")

    return systemEvents
  }
}
