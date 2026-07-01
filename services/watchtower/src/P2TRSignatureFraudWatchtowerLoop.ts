import type {
  P2TRSignatureFraudWatchtowerCycleReport,
  P2TRSignatureFraudWatchtowerServiceLogger,
} from "./types.js"

export type P2TRSignatureFraudWatchtowerLoopService = {
  processCycle(): Promise<P2TRSignatureFraudWatchtowerCycleReport>
}

export type P2TRSignatureFraudWatchtowerLoopOptions = {
  pollIntervalMs: number
  maxCycles?: number
  signal?: AbortSignal
  continueOnError?: boolean
  logger?: P2TRSignatureFraudWatchtowerServiceLogger
  delay?: P2TRSignatureFraudWatchtowerDelay
  onCycleReport?: (
    report: P2TRSignatureFraudWatchtowerCycleReport
  ) => void | Promise<void>
  onCycleError?: (error: unknown) => void | Promise<void>
}

export type P2TRSignatureFraudWatchtowerDelay = (
  milliseconds: number,
  signal?: AbortSignal
) => Promise<void>

export type P2TRSignatureFraudWatchtowerLoopResult = {
  cyclesAttempted: number
  cyclesSucceeded: number
  cyclesFailed: number
  stoppedBySignal: boolean
}

export async function runP2TRSignatureFraudWatchtowerLoop(
  service: P2TRSignatureFraudWatchtowerLoopService,
  options: P2TRSignatureFraudWatchtowerLoopOptions
): Promise<P2TRSignatureFraudWatchtowerLoopResult> {
  validateLoopOptions(options)

  const delay = options.delay ?? abortableDelay
  let cyclesAttempted = 0
  let cyclesSucceeded = 0
  let cyclesFailed = 0

  while (
    !options.signal?.aborted &&
    hasCyclesRemaining(options, cyclesAttempted)
  ) {
    cyclesAttempted++

    try {
      const report = await service.processCycle()
      cyclesSucceeded++
      await options.onCycleReport?.(report)
    } catch (error) {
      cyclesFailed++
      options.logger?.error("P2TR watchtower cycle failed", {
        error: errorMessage(error),
      })
      await options.onCycleError?.(error)

      if (!options.continueOnError) {
        throw error
      }
    }

    if (
      options.signal?.aborted ||
      !hasCyclesRemaining(options, cyclesAttempted)
    ) {
      break
    }

    await delay(options.pollIntervalMs, options.signal)
  }

  return {
    cyclesAttempted,
    cyclesSucceeded,
    cyclesFailed,
    stoppedBySignal: options.signal?.aborted ?? false,
  }
}

export function abortableDelay(
  milliseconds: number,
  signal?: AbortSignal
): Promise<void> {
  if (signal?.aborted) {
    return Promise.resolve()
  }

  return new Promise((resolve) => {
    const onAbort = () => {
      clearTimeout(timeout)
      resolve()
    }

    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort)
      resolve()
    }, milliseconds)

    signal?.addEventListener("abort", onAbort, { once: true })
  })
}

function validateLoopOptions(
  options: P2TRSignatureFraudWatchtowerLoopOptions
): void {
  if (!Number.isInteger(options.pollIntervalMs) || options.pollIntervalMs < 0) {
    throw new Error(
      "P2TR watchtower poll interval must be a non-negative integer"
    )
  }

  if (
    options.maxCycles !== undefined &&
    (!Number.isInteger(options.maxCycles) || options.maxCycles <= 0)
  ) {
    throw new Error("P2TR watchtower max cycles must be a positive integer")
  }
}

function hasCyclesRemaining(
  options: P2TRSignatureFraudWatchtowerLoopOptions,
  cyclesAttempted: number
): boolean {
  return options.maxCycles === undefined || cyclesAttempted < options.maxCycles
}

function errorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : String(error)
}
