import axios from "axios"

import { SystemEventType } from "./system-event"

import type { Monitor, SystemEvent } from "./system-event"

export const reservationKeeperMetricNames = {
  lateProofAtRiskCount: "reservation_acceptance_late_proof_at_risk_count",
  noEligibleTargetCount: "reservation_reanchor_no_eligible_target_count",
  vaultFeeDebtSat: "reservation_vault_fee_debt_sat",
  unrequestedDepositDeadlineAtRiskCount:
    "reservation_unrequested_deposit_deadline_at_risk_count",
  observationTimestamp: "reservation_keeper_observation_timestamp",
} as const

type MetricFetcher = (url: string, timeoutMs: number) => Promise<string>

export interface ReservationKeeperMonitorOptions {
  observationMaxAgeSeconds: number
  blockTimestamp: (block: number) => Promise<number>
  // Time of the chain head the keeper observed against. When supplied,
  // freshness is judged against this time instead of the scanned window's
  // end block, so a catch-up scan of an old window cannot flag a healthy
  // keeper. Tolerated on both sides: the keeper's RPC may lead or lag the
  // monitor's RPC by up to one observation max age.
  latestBlockTimestamp?: () => Promise<number>
  fetcher?: MetricFetcher
}

// Bound the request so a hung keeper endpoint cannot stall the scan.
const fetchTimeoutMs = 15000

const defaultFetcher: MetricFetcher = async (url, timeoutMs) => {
  const response = await axios.get<string>(url, {
    timeout: timeoutMs,
    responseType: "text",
    transformResponse: [(data) => data],
  })
  return response.data
}

function parseMetricSamples(text: string): Record<string, string> {
  const samples: Record<string, string> = {}
  text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.startsWith("#"))
    .forEach((line) => {
      const tokens = line.split(/\s+/)
      const rawName = tokens[0] ?? ""
      // A sample may carry labels; the metric name is the part before them.
      const name = rawName.includes("{")
        ? rawName.slice(0, rawName.indexOf("{"))
        : rawName
      const value = tokens[1]
      if (name.length === 0 || value === undefined) return
      // The first sample per name wins; keep-core emits one series per gauge.
      if (!(name in samples)) samples[name] = value
    })
  return samples
}

function parseNonNegativeNumber(value: string | undefined): number | null {
  if (value === undefined) return null
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) return null
  return parsed
}

export class ReservationKeeperMonitor implements Monitor {
  private readonly url: string

  private readonly options: ReservationKeeperMonitorOptions & {
    fetcher: MetricFetcher
  }

  constructor(url: string, options: ReservationKeeperMonitorOptions) {
    if (
      !Number.isSafeInteger(options.observationMaxAgeSeconds) ||
      options.observationMaxAgeSeconds <= 0
    ) {
      throw new Error("invalid observation max age")
    }
    this.url = url
    this.options = { ...options, fetcher: options.fetcher ?? defaultFetcher }
  }

  async check(fromBlock: number, toBlock: number): Promise<SystemEvent[]> {
    const names = reservationKeeperMetricNames
    const {
      observationMaxAgeSeconds,
      blockTimestamp,
      latestBlockTimestamp,
      fetcher,
    } = this.options
    const scannedTime = await blockTimestamp(toBlock)
    // Judge freshness against the chain head the keeper observed, not the
    // scanned window's end block, which can lag the head on a catch-up pass.
    const referenceTime = latestBlockTimestamp
      ? await latestBlockTimestamp()
      : scannedTime
    const events: SystemEvent[] = []

    let text: string
    try {
      text = await fetcher(this.url, fetchTimeoutMs)
    } catch (error) {
      // A failed endpoint is stale keeper data, not a healthy system.
      events.push(
        staleEvent(toBlock, scannedTime, "metrics endpoint unavailable")
      )
      return events
    }

    let samples: Record<string, string>
    try {
      samples = parseMetricSamples(text)
    } catch (error) {
      events.push(
        staleEvent(toBlock, scannedTime, "metrics response malformed")
      )
      return events
    }

    const lateProof = parseNonNegativeNumber(
      samples[names.lateProofAtRiskCount]
    )
    const noEligibleTargets = parseNonNegativeNumber(
      samples[names.noEligibleTargetCount]
    )
    const vaultFeeDebtSat = parseNonNegativeNumber(
      samples[names.vaultFeeDebtSat]
    )
    const unrequestedDeposits = parseNonNegativeNumber(
      samples[names.unrequestedDepositDeadlineAtRiskCount]
    )

    if (
      lateProof === null ||
      noEligibleTargets === null ||
      vaultFeeDebtSat === null ||
      unrequestedDeposits === null
    ) {
      // Never treat a metric sample that is missing or unparseable as healthy.
      events.push(
        staleEvent(
          toBlock,
          scannedTime,
          "metrics response malformed: missing or invalid sample"
        )
      )
      return events
    }

    if (lateProof > 0) {
      events.push({
        title: "Reservation keeper late acceptance proofs at risk",
        type: SystemEventType.Critical,
        data: { lateProofAtRiskCount: String(lateProof) },
        block: toBlock,
      })
    }
    if (noEligibleTargets > 0) {
      events.push({
        title: "Reservation keeper re-anchor has no eligible target",
        type: SystemEventType.Critical,
        data: { noEligibleTargetCount: String(noEligibleTargets) },
        block: toBlock,
      })
    }
    if (vaultFeeDebtSat > 0) {
      events.push({
        title: "Reservation keeper vault fee debt",
        type: SystemEventType.Warning,
        data: { vaultFeeDebtSat: String(vaultFeeDebtSat) },
        block: toBlock,
      })
    }
    if (unrequestedDeposits > 0) {
      events.push({
        title: "Reservation keeper unrequested deposit deadline at risk",
        type: SystemEventType.Warning,
        data: {
          unrequestedDepositDeadlineAtRiskCount: String(unrequestedDeposits),
        },
        block: toBlock,
      })
    }

    const rawTimestamp = samples[names.observationTimestamp]
    const timestamp = parseNonNegativeNumber(rawTimestamp)
    if (rawTimestamp === undefined || timestamp === null) {
      events.push(
        staleEvent(
          toBlock,
          referenceTime,
          `missing ${names.observationTimestamp} sample`
        )
      )
    } else {
      // Tolerate RPC skew: the keeper and the monitor may read the chain head
      // up to one observation max age apart without either being wrong.
      const deviation = timestamp - referenceTime
      if (deviation < -observationMaxAgeSeconds) {
        events.push(
          staleEvent(
            toBlock,
            referenceTime,
            "keeper observation older than the maximum age",
            rawTimestamp
          )
        )
      } else if (deviation > observationMaxAgeSeconds) {
        events.push(
          staleEvent(
            toBlock,
            referenceTime,
            "keeper observation ahead of the maximum age",
            rawTimestamp
          )
        )
      }
    }

    return events
  }
}

function staleEvent(
  block: number,
  chainTime: number,
  reason: string,
  observationTimestamp?: string
): SystemEvent {
  const data: Record<string, string> = {
    reason,
    chainBlockTime: String(chainTime),
  }
  if (observationTimestamp !== undefined) {
    data.observationTimestamp = observationTimestamp
  }
  return {
    title: "Reservation keeper metrics stale",
    type: SystemEventType.Critical,
    data,
    block,
  }
}
