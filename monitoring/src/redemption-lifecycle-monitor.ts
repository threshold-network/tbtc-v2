import { SystemEventType } from "./system-event"
import { createBtcTxUrl, createEthTxUrl } from "./block-explorer"
import { satsToRoundedBTC } from "./deposit-monitor"

import type { RedemptionRequestedEvent } from "@keep-network/tbtc-v2.ts"
import type { Monitor, SystemEvent } from "./system-event"
import type { RedemptionLifecycleSource } from "./redemption-chain"

export class RedemptionLifecycleMonitor implements Monitor {
  constructor(
    private readonly chain: RedemptionLifecycleSource,
    private readonly warningSeconds: number = 6 * 60 * 60
  ) {
    if (!Number.isSafeInteger(warningSeconds) || warningSeconds <= 0) {
      throw new Error(
        "redemption timeout warning must be a positive integer in seconds"
      )
    }
  }

  async check(fromBlock: number, toBlock: number): Promise<SystemEvent[]> {
    const [completed, timedOut, pending] = await Promise.all([
      this.chain.completed(fromBlock, toBlock),
      this.chain.timedOut(fromBlock, toBlock),
      this.checkPending(fromBlock, toBlock),
    ])
    return [
      ...completed.map(
        (event): SystemEvent => ({
          title: "Redemption proof accepted",
          type: SystemEventType.Informational,
          data: {
            walletPublicKeyHash: event.walletPublicKeyHash.toString(),
            redemptionTxHash: event.redemptionTxHash.toString(),
            redemptionTxHashURL: createBtcTxUrl(event.redemptionTxHash),
            ethProofTxHash: event.transactionHash.toPrefixedString(),
            ethProofTxHashURL: createEthTxUrl(event.transactionHash),
          },
          block: event.blockNumber,
        })
      ),
      ...timedOut.map(
        (event): SystemEvent => ({
          title: "Redemption timeout reported",
          type: SystemEventType.Critical,
          data: {
            walletPublicKeyHash: event.walletPublicKeyHash.toString(),
            redeemerOutputScript: event.redeemerOutputScript.toString(),
            ethTimeoutTxHash: event.transactionHash.toPrefixedString(),
            ethTimeoutTxHashURL: createEthTxUrl(event.transactionHash),
          },
          block: event.blockNumber,
        })
      ),
      ...pending,
    ]
  }

  private async checkPending(
    fromBlock: number,
    toBlock: number
  ): Promise<SystemEvent[]> {
    // Cache timestamps only for this run so a later run can observe a reorg.
    const timestamps = new Map<number, Promise<number>>()
    const timestamp = (block: number): Promise<number> => {
      const existing = timestamps.get(block)
      if (existing) return existing
      const pending = this.chain.blockTimestamp(block)
      timestamps.set(block, pending)
      return pending
    }
    const timeout = await this.chain.timeout(toBlock)
    // A backfill or reorg allowance can precede deployment entirely.
    if (timeout === undefined) return []
    if (timeout <= 0) throw new Error("invalid Bridge redemption timeout")
    let initializedFromBlock = fromBlock
    let previousTimeout = await this.chain.timeout(fromBlock)
    if (previousTimeout === undefined) {
      // Find the first deployed state inside the window, so the old timeout is
      // historical even if governance changed it before the end of a backfill.
      let low = fromBlock + 1
      let high = toBlock
      while (low < high) {
        const mid = Math.floor((low + high) / 2)
        // eslint-disable-next-line no-await-in-loop
        if ((await this.chain.timeout(mid)) === undefined) low = mid + 1
        else high = mid
      }
      initializedFromBlock = low
      previousTimeout = await this.chain.timeout(initializedFromBlock)
    }
    if (previousTimeout === undefined || previousTimeout <= 0)
      throw new Error("invalid Bridge redemption timeout")
    const [fromTime, toTime] = await Promise.all([
      timestamp(initializedFromBlock),
      timestamp(toBlock),
    ])

    // Query requests whose warning or expiry can cross this checkpoint window.
    // Include the old timeout so reductions through governance cannot hide a
    // newly expired request. State reads use the same end block as the events.
    const earliest = Math.max(
      0,
      fromTime - Math.max(previousTimeout, timeout) - 1
    )
    const latest = Math.max(
      0,
      toTime - timeout + Math.min(this.warningSeconds, timeout)
    )
    const firstAtOrAfter = async (target: number): Promise<number> => {
      let low = 0
      let high = toBlock + 1
      while (low < high) {
        const mid = Math.floor((low + high) / 2)
        // eslint-disable-next-line no-await-in-loop
        if ((await timestamp(mid)) < target) low = mid + 1
        else high = mid
      }
      return low
    }
    const [start, end] = await Promise.all([
      firstAtOrAfter(earliest),
      firstAtOrAfter(latest + 1),
    ])
    const requests =
      start < end ? await this.chain.requested(start, end - 1) : []
    const events: SystemEvent[] = []
    // Sequential request reads bound concurrency when a window contains many requests.
    // eslint-disable-next-line no-restricted-syntax
    for (const request of requests) {
      // eslint-disable-next-line no-await-in-loop
      const requestedAt = await timestamp(request.blockNumber)
      const deadline = requestedAt + timeout
      const previousDeadline = requestedAt + previousTimeout
      const crossed = (threshold: number, previous: number) =>
        threshold <= toTime &&
        (threshold >= fromTime ||
          (timeout !== previousTimeout && previous >= fromTime))

      // The contract permits a timeout report strictly AFTER the deadline.
      const expired =
        deadline < toTime && crossed(deadline + 1, previousDeadline + 1)
      const nearTimeout =
        deadline >= toTime &&
        crossed(
          deadline - Math.min(this.warningSeconds, timeout),
          previousDeadline - Math.min(this.warningSeconds, previousTimeout)
        )
      if (expired || nearTimeout) {
        // A wallet/script pair can be reused: match its current requestedAt to
        // this event, rather than alerting on an older completed request.
        // eslint-disable-next-line no-await-in-loop
        const pendingAt = await this.chain.pendingRequestedAt(request, toBlock)
        if (pendingAt !== 0 && pendingAt === requestedAt) {
          events.push(
            RedemptionLifecycleMonitor.deadlineEvent(request, deadline, expired)
          )
        }
      }
    }
    return events
  }

  private static deadlineEvent(
    request: RedemptionRequestedEvent,
    deadline: number,
    expired: boolean
  ): SystemEvent {
    return {
      title: expired
        ? "Redemption expired without proof"
        : "Redemption nearing timeout",
      type: expired ? SystemEventType.Critical : SystemEventType.Warning,
      // Keep the payload stable across overlapping/retried windows. Do not add
      // the current block, wall clock, or remaining time to the deduplication key.
      data: {
        walletPublicKeyHash: request.walletPublicKeyHash.toString(),
        redeemerOutputScript: request.redeemerOutputScript.toString(),
        requestedAmountBTC: satsToRoundedBTC(request.requestedAmount),
        ethRequestTxHash: request.transactionHash.toPrefixedString(),
        ethRequestTxHashURL: createEthTxUrl(request.transactionHash),
        deadlineTimestamp: `${deadline}`,
      },
      block: request.blockNumber,
    }
  }
}
