import { BigNumber } from "ethers"

import { context } from "./context"
import { SystemEventType } from "./system-event"
import { satsToRoundedBTC } from "./deposit-monitor"
import { createEthTxUrl } from "./block-explorer"
import { blocks } from "./blocks"

import type { Monitor as SystemEventMonitor, SystemEvent } from "./system-event"
import type {
  Bridge,
  RedemptionRequestedEvent as RedemptionRequestedChainEvent,
} from "@keep-network/tbtc-v2.ts/core"

// The time after which a pending redemption request is considered stale.
// Typically, a redemption request processing time should not exceed 5 hours.
// A redemption request pending for 8 hours indicates that something is wrong.
// This value is expressed in blocks, assuming 12 seconds per block.
const redemptionRequestStaleBlocks = (8 * 60 * 60) / 12

const RedemptionRequested = (
  chainEvent: RedemptionRequestedChainEvent
): SystemEvent => {
  const ethRequestTxHashURL = createEthTxUrl(chainEvent.transactionHash)

  return {
    title: "Redemption requested",
    type: SystemEventType.Informational,
    data: {
      walletPublicKeyHash: chainEvent.walletPublicKeyHash.toString(),
      redeemerOutputScript: chainEvent.redeemerOutputScript.toString(),
      requestedAmountBTC: satsToRoundedBTC(chainEvent.requestedAmount),
      ethRequestTxHash: chainEvent.transactionHash.toPrefixedString(),
      ethRequestTxHashURL,
    },
    block: chainEvent.blockNumber,
  }
}

const LargeRedemptionRequested = (
  chainEvent: RedemptionRequestedChainEvent
): SystemEvent => {
  const ethRequestTxHashURL = createEthTxUrl(chainEvent.transactionHash)

  return {
    title: "Large redemption requested",
    type: SystemEventType.Warning,
    data: {
      walletPublicKeyHash: chainEvent.walletPublicKeyHash.toString(),
      redeemerOutputScript: chainEvent.redeemerOutputScript.toString(),
      requestedAmountBTC: satsToRoundedBTC(chainEvent.requestedAmount),
      ethRequestTxHash: chainEvent.transactionHash.toPrefixedString(),
      ethRequestTxHashURL,
    },
    block: chainEvent.blockNumber,
  }
}

const StaleRedemption = (
  chainEvent: RedemptionRequestedChainEvent
): SystemEvent => {
  const ethRequestTxHashURL = createEthTxUrl(chainEvent.transactionHash)

  return {
    title: "Stale redemption",
    type: SystemEventType.Warning,
    data: {
      walletPublicKeyHash: chainEvent.walletPublicKeyHash.toString(),
      redeemerOutputScript: chainEvent.redeemerOutputScript.toString(),
      requestedAmountBTC: satsToRoundedBTC(chainEvent.requestedAmount),
      ethRequestTxHash: chainEvent.transactionHash.toPrefixedString(),
      ethRequestTxHashURL,
    },
    block: chainEvent.blockNumber,
  }
}

export class RedemptionMonitor implements SystemEventMonitor {
  private bridge: Bridge

  constructor(bridge: Bridge) {
    this.bridge = bridge
  }

  async check(fromBlock: number, toBlock: number): Promise<SystemEvent[]> {
    // eslint-disable-next-line no-console
    console.log("running redemption monitor check")

    const systemEvents: SystemEvent[] = []
    systemEvents.push(
      ...(await this.checkRequestedRedemptions(fromBlock, toBlock))
    )
    systemEvents.push(...(await this.checkStaleRedemptions(fromBlock, toBlock)))

    // eslint-disable-next-line no-console
    console.log("completed redemption monitor check")

    return systemEvents
  }

  private async checkRequestedRedemptions(
    fromBlock: number,
    toBlock: number
  ): Promise<SystemEvent[]> {
    const chainEvents = await this.bridge.getRedemptionRequestedEvents({
      fromBlock,
      toBlock,
    })

    const systemEvents: SystemEvent[] = []

    // eslint-disable-next-line no-plusplus
    for (let i = 0; i < chainEvents.length; i++) {
      const chainEvent = chainEvents[i]

      systemEvents.push(RedemptionRequested(chainEvent))

      if (
        chainEvent.requestedAmount.gt(
          BigNumber.from(context.largeRedemptionThresholdSat)
        )
      ) {
        systemEvents.push(LargeRedemptionRequested(chainEvent))
      }
    }

    return systemEvents
  }

  private async checkStaleRedemptions(
    fromBlock: number,
    toBlock: number
  ): Promise<SystemEvent[]> {
    const rewindBlock = (block: number, shift: number) =>
      block - shift > 0 ? block - shift : 0

    // We need to rewind the block window by the minting request timeout.
    // This way, we are looking for past deposits whose time for creating
    // the minting request was already elapsed.
    const chainEvents = await this.bridge.getRedemptionRequestedEvents({
      fromBlock: rewindBlock(fromBlock, redemptionRequestStaleBlocks),
      toBlock: rewindBlock(toBlock, redemptionRequestStaleBlocks),
    })

    const chainEventsTimestamps = await Promise.all(
      chainEvents.map((ce) => blocks.blockTimestamp(ce.blockNumber))
    )

    const pendingRedemptionsRequests = await Promise.all(
      chainEvents.map((ce) =>
        this.bridge.pendingRedemptionsByWalletPKH(
          ce.walletPublicKeyHash,
          ce.redeemerOutputScript
        )
      )
    )

    return chainEvents
      .filter((ce, index) => {
        const pendingRedemptionRequest = pendingRedemptionsRequests[index]
        const chainEventTimestamp = chainEventsTimestamps[index]

        // To consider a redemption as stale, the redemption request must be
        // still pending after redemptionRequestStaleBlocks. As there can
        // be multiple redemption requests for the given wallet and
        // redeemer output script pair, we need to make sure the pending
        // redemption request timestamp matches the timestamp of the given
        // chain event emission block.
        return (
          pendingRedemptionRequest.requestedAt !== 0 &&
          pendingRedemptionRequest.requestedAt === chainEventTimestamp
        )
      })
      .map(StaleRedemption)
  }
}
