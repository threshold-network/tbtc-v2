import {
  P2TR_SIGNATURE_FRAUD_SPEND_TYPE_HEARTBEAT,
  P2TR_SIGNATURE_FRAUD_SPEND_TYPE_UNCLASSIFIED,
  P2TR_SIGNATURE_FRAUD_SPEND_TYPE_WALLET_CLOSING,
  P2TRSignatureFraudWatchtower,
  P2TRSignatureFraudWatchtowerRunner,
  P2TRWatchtowerSerializedChallengeStore,
} from "@keep-network/tbtc-v2.ts"
import type {
  P2TRSignatureFraudChallengeSubmitter,
  P2TRSignatureFraudWatchtowerBridgeLifecycleFailure,
  P2TRSignatureFraudWatchtowerProcessingFailure,
  P2TRSignatureFraudSpendType,
  P2TRSignatureFraudWitnessObservation,
  P2TRSignatureFraudWatchtowerSubmissionResult,
  P2TRWatchtowerConfirmedTransaction,
  P2TRWatchtowerMempoolTransaction,
} from "@keep-network/tbtc-v2.ts"

import type {
  P2TRSignatureFraudWatchtowerCycleMetrics,
  P2TRSignatureFraudWatchtowerCycleReport,
  P2TRSignatureFraudWatchtowerIdempotentChallengeSubmitter,
  P2TRSignatureFraudWatchtowerServiceAlert,
  P2TRSignatureFraudWatchtowerServiceConfig,
  P2TRSignatureFraudWatchtowerServiceDependencies,
  P2TRSignatureFraudWatchtowerStoreProfileProvider,
  P2TRSignatureFraudWatchtowerTransactionCoordinator,
} from "./types.js"

const DEFAULT_ALERT_DEDUPLICATION_WINDOW_MS = 60_000
const MAX_ALERT_FAILURE_SUMMARIES = 20

export class P2TRSignatureFraudWatchtowerService {
  private readonly alertLastEmittedAt = new Map<string, number>()

  constructor(
    private readonly config: P2TRSignatureFraudWatchtowerServiceConfig,
    private readonly dependencies: P2TRSignatureFraudWatchtowerServiceDependencies
  ) {
    if (config.registeredWalletIDs.length === 0) {
      throw new Error(
        "P2TR signature-fraud watchtower requires at least one registered wallet ID"
      )
    }

    if (
      config.submitChallenges === true &&
      dependencies.challengeSubmitter === undefined
    ) {
      throw new Error(
        "P2TR signature-fraud watchtower requires a challenge submitter when submissions are enabled"
      )
    }

    if (
      config.submitChallenges === true &&
      (config.submissionPolicy?.allowedSpendTypes?.length ?? 0) === 0
    ) {
      throw new Error(
        "P2TR signature-fraud watchtower requires at least one approved spend type when submissions are enabled"
      )
    }

    if (config.submitChallenges === true) {
      rejectFailClosedSubmissionSpendTypes(config)
    }

    if (config.submitChallenges === true) {
      requireExplicitPayloadBounds(config.payloadBounds)
    }

    if (
      config.submitChallenges === true &&
      config.bridgeChallengeDomain === undefined
    ) {
      throw new Error(
        "P2TR signature-fraud watchtower requires a Bridge challenge domain when submissions are enabled"
      )
    }

    if (
      config.submitChallenges === true &&
      config.spendTypeClassifier === undefined
    ) {
      throw new Error(
        "P2TR signature-fraud watchtower requires a spend-type classifier when submissions are enabled"
      )
    }

    if (
      config.submitChallenges === true &&
      (config.maxSubmissionAttempts === undefined ||
        config.submissionAttemptLimitAlert === undefined)
    ) {
      throw new Error(
        "P2TR signature-fraud watchtower requires a submission-attempt ceiling and alert when submissions are enabled"
      )
    }

    if (config.submitChallenges === true) {
      requireSubmissionIndexingStoreProfile(config)
      requireProductionStoresForProductionProfile(config, dependencies)
      requireIdempotentProductionSubmitter(config, dependencies)
    }

    // Alert sink is required for any transactional-production deployment,
    // including observation-only profiles, so source/item/cursor-commit
    // failures cannot silently fall back to the log-only path.
    requireProductionAlertSink(config, dependencies)
  }

  async processCycle(): Promise<P2TRSignatureFraudWatchtowerCycleReport> {
    const startedAt = new Date().toISOString()

    type CycleSuccess = {
      result: P2TRSignatureFraudWatchtowerCycleReport["result"]
      metrics: P2TRSignatureFraudWatchtowerCycleMetrics
    }

    let success: CycleSuccess
    try {
      success = await this.runIndexingCycleTransaction(async () => {
        const store = new P2TRWatchtowerSerializedChallengeStore(
          this.dependencies.persistence
        )
        const runner = this.createRunner(store)
        const cycleResult = await runner.processWatchtowerSourcesSettled(
          this.dependencies.transactionSource,
          this.dependencies.bridgeLifecycleEventSource,
          store
        )
        const cycleMetrics =
          buildP2TRSignatureFraudWatchtowerCycleMetrics(cycleResult)

        // Emit per-cycle source/item/operator alerts before the cursor commit
        // so a transactional cursor-commit failure cannot silently drop the
        // fraud-relevant failure context detected earlier in this cycle.
        await this.emitCycleAlerts(cycleResult, cycleMetrics)

        await commitBridgeLifecycleScanIfSafe(
          this.dependencies.bridgeLifecycleEventSource,
          cycleResult
        )

        return { result: cycleResult, metrics: cycleMetrics }
      })
    } catch (error) {
      if (error instanceof BridgeLifecycleCursorCommitError) {
        const fields = this.bridgeLifecycleCursorCommitFailureFields(
          error,
          startedAt
        )
        this.dependencies.logger?.error(
          "P2TR watchtower Bridge lifecycle cursor commit failed",
          fields
        )
        await this.emitAlert({
          code: "bridge-lifecycle-cursor-commit-failed",
          severity: "error",
          message: "P2TR watchtower Bridge lifecycle cursor commit failed",
          fields,
        })
      }

      throw error
    }

    const completedAt = new Date().toISOString()
    this.logCycleCompletion(success.metrics)

    return {
      startedAt,
      completedAt,
      result: success.result,
      metrics: success.metrics,
    }
  }

  private async runIndexingCycleTransaction<T>(
    operation: () => Promise<T>
  ): Promise<T> {
    if (!usesProductionIndexingTransaction(this.config)) {
      return operation()
    }

    const transactionCoordinator = this.dependencies.transactionCoordinator
    if (!hasIndexingTransactionCoordinator(transactionCoordinator)) {
      throw new Error(
        "P2TR signature-fraud watchtower transactional-production indexing profile requires a transaction coordinator"
      )
    }

    let operationSucceeded = false
    let operationFailed = false
    let operationResult: T | undefined

    const result =
      await transactionCoordinator.runInP2TRSignatureFraudWatchtowerTransaction(
        async () => {
          try {
            operationResult = await operation()
            operationSucceeded = true
            return operationResult
          } catch (error) {
            operationFailed = true
            throw error
          }
        }
      )

    if (operationFailed) {
      throw new Error(
        "P2TR signature-fraud watchtower transaction coordinator suppressed an indexing operation failure"
      )
    }

    if (!operationSucceeded || result !== operationResult) {
      throw new Error(
        "P2TR signature-fraud watchtower transaction coordinator must execute and return the indexing operation result"
      )
    }

    return result
  }

  private createRunner(
    store: P2TRWatchtowerSerializedChallengeStore
  ): P2TRSignatureFraudWatchtowerRunner {
    return new P2TRSignatureFraudWatchtowerRunner(
      new P2TRSignatureFraudWatchtower(
        store,
        this.config.registeredWalletIDs,
        this.config.bridgeIdentifier,
        this.config.spendTypeClassifier,
        this.config.payloadBounds,
        this.config.bridgeChallengeDomain
      ),
      this.dependencies.bitcoinClient,
      this.dependencies.challengeSubmitter ??
        new DisabledP2TRChallengeSubmitter(),
      {
        submitChallenges: this.config.submitChallenges ?? false,
        maxSubmissionAttempts: this.config.maxSubmissionAttempts,
        submissionAttemptLimitAlert: this.config.submissionAttemptLimitAlert,
        submissionPolicy: this.config.submissionPolicy,
      }
    )
  }

  private bridgeLifecycleCursorCommitFailureFields(
    error: BridgeLifecycleCursorCommitError,
    cycleStartedAt: string
  ): Extract<
    P2TRSignatureFraudWatchtowerServiceAlert,
    { code: "bridge-lifecycle-cursor-commit-failed" }
  >["fields"] {
    return {
      error: serviceErrorMessage(error.cause),
      storeId:
        transactionalStoreID(this.dependencies.bridgeLifecycleEventSource) ??
        transactionalStoreID(this.dependencies.persistence) ??
        "unmarked",
      bridgeIdentifier: this.config.bridgeIdentifier ?? "unconfigured",
      cycleStartedAt,
    }
  }

  private async emitCycleAlerts(
    result: P2TRSignatureFraudWatchtowerCycleReport["result"],
    metrics: P2TRSignatureFraudWatchtowerCycleMetrics
  ): Promise<void> {
    if (metrics.sourceFailures > 0) {
      const fields = {
        sourceFailures: result.sourceFailures,
      }
      this.dependencies.logger?.error("P2TR watchtower source failures", fields)
      await this.emitAlert(
        {
          code: "watchtower-source-failures",
          severity: "error",
          message: "P2TR watchtower source failures",
          fields,
        },
        metrics
      )
    }

    const itemFailures =
      metrics.mempoolFailures +
      metrics.confirmedFailures +
      metrics.bridgeLifecycleFailures

    if (itemFailures > 0) {
      const fields = {
        itemFailures,
        mempoolFailures: summarizeFailureList(
          result.mempool.failures,
          summarizeP2TRTransactionFailure
        ),
        confirmedFailures: summarizeFailureList(
          result.confirmed.failures,
          summarizeP2TRConfirmedTransactionFailure
        ),
        bridgeLifecycleFailures: summarizeFailureList(
          result.bridgeLifecycle.failures,
          summarizeP2TRBridgeLifecycleFailure
        ),
      }
      this.dependencies.logger?.warn("P2TR watchtower item failures", fields)
      await this.emitAlert(
        {
          code: "watchtower-item-failures",
          severity: "warning",
          message: "P2TR watchtower item failures",
          fields,
        },
        metrics
      )
    }

    if (metrics.unresolvedOperatorAlerts > 0) {
      const fields = {
        unresolvedOperatorAlerts: metrics.unresolvedOperatorAlerts,
      }
      this.dependencies.logger?.warn(
        "P2TR watchtower operator alerts open",
        fields
      )
      await this.emitAlert(
        {
          code: "watchtower-operator-alerts-open",
          severity: "warning",
          message: "P2TR watchtower operator alerts open",
          fields,
        },
        metrics
      )
    }
  }

  private logCycleCompletion(
    metrics: P2TRSignatureFraudWatchtowerCycleMetrics
  ): void {
    this.dependencies.logger?.info("P2TR watchtower cycle completed", {
      metrics,
    })
  }

  private async emitAlert(
    alert: P2TRSignatureFraudWatchtowerServiceAlert,
    metrics?: P2TRSignatureFraudWatchtowerCycleMetrics
  ): Promise<void> {
    if (this.dependencies.alertSink === undefined) {
      return
    }

    if (this.shouldSuppressAlert(alert)) {
      return
    }

    try {
      await this.dependencies.alertSink.emitAlert(alert)
    } catch (error) {
      if (metrics !== undefined) {
        metrics.alertSinkFailures++
      }
      this.dependencies.logger?.error("P2TR watchtower alert sink failed", {
        alertCode: alert.code,
        error: serviceErrorMessage(error),
      })
    }
  }

  private shouldSuppressAlert(
    alert: P2TRSignatureFraudWatchtowerServiceAlert
  ): boolean {
    const deduplicationWindowMs =
      this.config.alertDeduplicationWindowMs ??
      DEFAULT_ALERT_DEDUPLICATION_WINDOW_MS

    if (deduplicationWindowMs <= 0) {
      return false
    }

    const key = alertDeduplicationKey(alert)
    const now = Date.now()
    const lastEmittedAt = this.alertLastEmittedAt.get(key)

    if (
      lastEmittedAt !== undefined &&
      now - lastEmittedAt < deduplicationWindowMs
    ) {
      return true
    }

    this.alertLastEmittedAt.set(key, now)
    return false
  }
}

class DisabledP2TRChallengeSubmitter
  implements P2TRSignatureFraudChallengeSubmitter
{
  async submitSignatureFraudChallenge(
    _observation: P2TRSignatureFraudWitnessObservation
  ): Promise<string> {
    throw new Error("P2TR signature-fraud challenge submission is disabled")
  }
}

class BridgeLifecycleCursorCommitError extends Error {
  constructor(readonly cause: unknown) {
    super(serviceErrorMessage(cause))
    this.name = "BridgeLifecycleCursorCommitError"
  }
}

type BridgeLifecycleScanCommitter = {
  commitBridgeLifecycleScan(): Promise<void>
}

async function commitBridgeLifecycleScanIfSafe(
  eventSource: unknown,
  result: P2TRSignatureFraudWatchtowerCycleReport["result"]
): Promise<void> {
  if (
    !hasBridgeLifecycleScanCommitter(eventSource) ||
    result.bridgeLifecycle.failures.length > 0 ||
    result.sourceFailures.some(
      (failure) => failure.source === "bridge-lifecycle"
    )
  ) {
    return
  }

  try {
    await eventSource.commitBridgeLifecycleScan()
  } catch (error) {
    throw new BridgeLifecycleCursorCommitError(error)
  }
}

function hasBridgeLifecycleScanCommitter(
  value: unknown
): value is BridgeLifecycleScanCommitter {
  return (
    typeof value === "object" &&
    value !== null &&
    "commitBridgeLifecycleScan" in value &&
    typeof value.commitBridgeLifecycleScan === "function"
  )
}

function requireExplicitPayloadBounds(
  bounds: P2TRSignatureFraudWatchtowerServiceConfig["payloadBounds"]
): void {
  if (
    bounds?.maxRawTransactionBytes === undefined ||
    bounds.maxInputs === undefined ||
    bounds.maxOutputs === undefined ||
    bounds.maxScriptPubKeyBytes === undefined
  ) {
    throw new Error(
      "P2TR signature-fraud watchtower requires explicit payload bounds when submissions are enabled"
    )
  }

  const configuredBounds = [
    ["raw transaction byte", bounds.maxRawTransactionBytes],
    ["input", bounds.maxInputs],
    ["output", bounds.maxOutputs],
    ["scriptPubKey byte", bounds.maxScriptPubKeyBytes],
  ] as const

  configuredBounds.forEach(([name, value]) => {
    if (!Number.isInteger(value) || value <= 0) {
      throw new Error(
        `P2TR signature-fraud watchtower ${name} payload bound must be a positive integer`
      )
    }
  })
}

const failClosedSubmissionSpendTypes = new Set<P2TRSignatureFraudSpendType>([
  P2TR_SIGNATURE_FRAUD_SPEND_TYPE_UNCLASSIFIED,
  P2TR_SIGNATURE_FRAUD_SPEND_TYPE_WALLET_CLOSING,
  P2TR_SIGNATURE_FRAUD_SPEND_TYPE_HEARTBEAT,
])

function rejectFailClosedSubmissionSpendTypes(
  config: P2TRSignatureFraudWatchtowerServiceConfig
): void {
  const failClosedSpendType = config.submissionPolicy?.allowedSpendTypes?.find(
    (spendType) =>
      failClosedSubmissionSpendTypes.has(
        spendType as P2TRSignatureFraudSpendType
      )
  )

  if (failClosedSpendType !== undefined) {
    throw new Error(
      `P2TR signature-fraud spend type ${failClosedSpendType} is fail-closed for challenge submission`
    )
  }
}

function requireSubmissionIndexingStoreProfile(
  config: P2TRSignatureFraudWatchtowerServiceConfig
): void {
  if (config.indexingStoreProfile === "transactional-production") {
    return
  }

  if (config.allowSingleProcessRehearsalSubmission === true) {
    return
  }

  throw new Error(
    "P2TR signature-fraud watchtower challenge submission requires a transactional production indexing store or explicit single-process rehearsal override"
  )
}

function requireProductionStoresForProductionProfile(
  config: P2TRSignatureFraudWatchtowerServiceConfig,
  dependencies: P2TRSignatureFraudWatchtowerServiceDependencies
): void {
  if (config.indexingStoreProfile !== "transactional-production") {
    return
  }

  const requiredStores = [
    ["challenge-record persistence", dependencies.persistence],
    ["Bridge lifecycle event source", dependencies.bridgeLifecycleEventSource],
  ] as const
  const transactionalStoreIDs: string[] = []

  for (const [label, dependency] of requiredStores) {
    const profile = storeProfile(dependency)

    if (profile !== "transactional-production") {
      throw new Error(
        `P2TR signature-fraud watchtower transactional-production indexing profile requires ${label} marked as transactional-production; got ${
          profile ?? "unmarked"
        }`
      )
    }

    const storeID = transactionalStoreID(dependency)
    if (storeID === undefined || storeID.length === 0) {
      throw new Error(
        `P2TR signature-fraud watchtower transactional-production indexing profile requires ${label} to declare a transactional store ID`
      )
    }

    transactionalStoreIDs.push(storeID)
  }

  if (!hasIndexingTransactionCoordinator(dependencies.transactionCoordinator)) {
    throw new Error(
      "P2TR signature-fraud watchtower transactional-production indexing profile requires a transaction coordinator"
    )
  }

  if (
    dependencies.transactionCoordinator
      .p2trSignatureFraudWatchtowerAtomicTransactions !== true
  ) {
    throw new Error(
      "P2TR signature-fraud watchtower transactional-production indexing profile requires a transaction coordinator that declares atomic rollback-on-error semantics"
    )
  }

  if (
    typeof dependencies.transactionCoordinator
      .assertP2TRSignatureFraudWatchtowerSharedStore !== "function"
  ) {
    throw new Error(
      "P2TR signature-fraud watchtower transactional-production indexing profile requires a transaction coordinator shared-store assertion"
    )
  }

  const coordinatorProfile = storeProfile(dependencies.transactionCoordinator)
  if (coordinatorProfile !== "transactional-production") {
    throw new Error(
      `P2TR signature-fraud watchtower transactional-production indexing profile requires transaction coordinator marked as transactional-production; got ${
        coordinatorProfile ?? "unmarked"
      }`
    )
  }

  const coordinatorStoreID = transactionalStoreID(
    dependencies.transactionCoordinator
  )
  if (coordinatorStoreID === undefined || coordinatorStoreID.length === 0) {
    throw new Error(
      "P2TR signature-fraud watchtower transactional-production indexing profile requires transaction coordinator to declare a transactional store ID"
    )
  }

  transactionalStoreIDs.push(coordinatorStoreID)

  if (new Set(transactionalStoreIDs).size !== 1) {
    throw new Error(
      "P2TR signature-fraud watchtower transactional-production indexing profile requires challenge-record persistence, Bridge lifecycle event source, and transaction coordinator to share the same transactional store ID"
    )
  }

  dependencies.transactionCoordinator.assertP2TRSignatureFraudWatchtowerSharedStore(
    {
      persistence: dependencies.persistence,
      bridgeLifecycleEventSource: dependencies.bridgeLifecycleEventSource,
    }
  )
}

function requireIdempotentProductionSubmitter(
  config: P2TRSignatureFraudWatchtowerServiceConfig,
  dependencies: P2TRSignatureFraudWatchtowerServiceDependencies
): void {
  if (config.indexingStoreProfile !== "transactional-production") {
    return
  }

  if (!hasIdempotentChallengeSubmitter(dependencies.challengeSubmitter)) {
    throw new Error(
      "P2TR signature-fraud watchtower transactional-production indexing profile requires an idempotent challenge submitter because on-chain submission cannot be rolled back with local cursor state"
    )
  }
}

function requireProductionAlertSink(
  config: P2TRSignatureFraudWatchtowerServiceConfig,
  dependencies: P2TRSignatureFraudWatchtowerServiceDependencies
): void {
  if (config.indexingStoreProfile !== "transactional-production") {
    return
  }

  if (dependencies.alertSink === undefined) {
    throw new Error(
      "P2TR signature-fraud watchtower transactional-production indexing profile requires an alert sink so source/item/cursor-commit failures cannot be observed-only"
    )
  }
}

function usesProductionIndexingTransaction(
  config: P2TRSignatureFraudWatchtowerServiceConfig
): boolean {
  return (
    config.submitChallenges === true &&
    config.indexingStoreProfile === "transactional-production"
  )
}

function hasIndexingTransactionCoordinator(
  value: unknown
): value is P2TRSignatureFraudWatchtowerTransactionCoordinator {
  return (
    typeof value === "object" &&
    value !== null &&
    "runInP2TRSignatureFraudWatchtowerTransaction" in value &&
    typeof value.runInP2TRSignatureFraudWatchtowerTransaction === "function"
  )
}

function hasIdempotentChallengeSubmitter(
  value: unknown
): value is P2TRSignatureFraudWatchtowerIdempotentChallengeSubmitter {
  return (
    typeof value === "object" &&
    value !== null &&
    "p2trSignatureFraudWatchtowerIdempotentSubmissions" in value &&
    value.p2trSignatureFraudWatchtowerIdempotentSubmissions === true &&
    "submitSignatureFraudChallenge" in value &&
    typeof value.submitSignatureFraudChallenge === "function"
  )
}

function storeProfile(
  dependency: unknown
): P2TRSignatureFraudWatchtowerStoreProfileProvider["p2trSignatureFraudWatchtowerStoreProfile"] {
  if (
    typeof dependency !== "object" ||
    dependency === null ||
    !("p2trSignatureFraudWatchtowerStoreProfile" in dependency)
  ) {
    return undefined
  }

  return (dependency as P2TRSignatureFraudWatchtowerStoreProfileProvider)
    .p2trSignatureFraudWatchtowerStoreProfile
}

function transactionalStoreID(dependency: unknown): string | undefined {
  if (
    typeof dependency !== "object" ||
    dependency === null ||
    !("p2trSignatureFraudWatchtowerTransactionalStoreID" in dependency)
  ) {
    return undefined
  }

  return (dependency as P2TRSignatureFraudWatchtowerStoreProfileProvider)
    .p2trSignatureFraudWatchtowerTransactionalStoreID
}

export function buildP2TRSignatureFraudWatchtowerCycleMetrics(
  result: P2TRSignatureFraudWatchtowerCycleReport["result"]
): P2TRSignatureFraudWatchtowerCycleMetrics {
  return {
    replayedRecords: result.replayed.length,
    replayedSubmissions: result.replayed.length,
    replayedSubmissionAttempts: countSubmissionAttempts(result.replayed),
    mempoolObservations: result.mempool.submissions.length,
    mempoolSubmissions: result.mempool.submissions.length,
    mempoolSubmissionAttempts: countSubmissionAttempts(
      result.mempool.submissions
    ),
    mempoolFailures: result.mempool.failures.length,
    confirmedObservations: result.confirmed.submissions.length,
    confirmedSubmissions: result.confirmed.submissions.length,
    confirmedSubmissionAttempts: countSubmissionAttempts(
      result.confirmed.submissions
    ),
    confirmedFailures: result.confirmed.failures.length,
    bridgeLifecycleRecords: result.bridgeLifecycle.records.length,
    bridgeLifecycleFailures: result.bridgeLifecycle.failures.length,
    bridgeLifecycleIgnored: result.bridgeLifecycle.ignored.length,
    sourceFailures: result.sourceFailures.length,
    totalRecords: result.summary.total,
    unresolvedOperatorAlerts: result.summary.unresolvedOperatorAlerts,
    alertSinkFailures: 0,
  }
}

function countSubmissionAttempts(
  results: P2TRSignatureFraudWatchtowerSubmissionResult[]
): number {
  return results.filter(
    ({ record, submissionRecord }) =>
      submissionRecord.submissionAttempts > record.submissionAttempts
  ).length
}

function summarizeP2TRTransactionFailure(
  failure: P2TRSignatureFraudWatchtowerProcessingFailure<P2TRWatchtowerMempoolTransaction>
): Record<string, unknown> {
  return {
    bitcoinTxHash: failure.transaction.bitcoinTxHash.toString(),
    error: failure.error,
  }
}

function summarizeFailureList<T>(
  failures: T[],
  summarize: (failure: T) => Record<string, unknown>
): Record<string, unknown> {
  return {
    count: failures.length,
    truncated: failures.length > MAX_ALERT_FAILURE_SUMMARIES,
    sample: failures.slice(0, MAX_ALERT_FAILURE_SUMMARIES).map(summarize),
  }
}

function summarizeP2TRConfirmedTransactionFailure(
  failure: P2TRSignatureFraudWatchtowerProcessingFailure<P2TRWatchtowerConfirmedTransaction>
): Record<string, unknown> {
  return {
    ...summarizeP2TRTransactionFailure(failure),
    bitcoinBlockHash: failure.transaction.bitcoinBlockHash.toString(),
    bitcoinBlockHeight: failure.transaction.bitcoinBlockHeight,
  }
}

function summarizeP2TRBridgeLifecycleFailure(
  failure: P2TRSignatureFraudWatchtowerBridgeLifecycleFailure
): Record<string, unknown> {
  return {
    event: failure.event,
    walletID:
      "walletID" in failure.event
        ? failure.event.walletID?.toString()
        : undefined,
    bridgeChallengeKey:
      "bridgeChallengeKey" in failure.event
        ? failure.event.bridgeChallengeKey?.toString()
        : undefined,
    observationID:
      "observationID" in failure.event
        ? failure.event.observationID?.toString()
        : undefined,
    error: failure.error,
  }
}

function alertDeduplicationKey(
  alert: P2TRSignatureFraudWatchtowerServiceAlert
): string {
  if (alert.code === "bridge-lifecycle-cursor-commit-failed") {
    return JSON.stringify({
      code: alert.code,
      error: alert.fields.error,
      storeId: alert.fields.storeId,
      bridgeIdentifier: alert.fields.bridgeIdentifier,
    })
  }

  return `${alert.code}:${JSON.stringify(alert.fields)}`
}

function serviceErrorMessage(error: unknown): string {
  return error instanceof Error && error.message.length > 0
    ? error.message
    : String(error)
}
