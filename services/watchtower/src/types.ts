import type {
  BitcoinClient,
  P2TRSignatureFraudBridgeChallengeDomain,
  P2TRSignatureFraudChallengeBroadcastReconciler,
  P2TRSignatureFraudChallengeSubmitter,
  P2TRSignatureFraudPayloadBounds,
  P2TRSignatureFraudSpendTypeClassifier,
  P2TRSignatureFraudWatchtowerBridgeLifecycleEventSource,
  P2TRSignatureFraudWatchtowerIntegratedCycleResult,
  P2TRSignatureFraudWatchtowerRunnerOptions,
  P2TRSignatureFraudWatchtowerTransactionSource,
  P2TRWatchtowerChallengeRecordPersistence,
} from "@keep-network/tbtc-v2.ts"

export type P2TRSignatureFraudWatchtowerServiceConfig =
  P2TRSignatureFraudWatchtowerRunnerOptions & {
    registeredWalletIDs: string[]
    bridgeIdentifier?: string
    bridgeChallengeDomain?: P2TRSignatureFraudBridgeChallengeDomain
    spendTypeClassifier?: P2TRSignatureFraudSpendTypeClassifier
    payloadBounds?: P2TRSignatureFraudPayloadBounds
    indexingStoreProfile?: P2TRSignatureFraudWatchtowerIndexingStoreProfile
    allowSingleProcessRehearsalSubmission?: boolean
    alertDeduplicationWindowMs?: number
  }

export type P2TRSignatureFraudWatchtowerIndexingStoreProfile =
  | "single-process-rehearsal"
  | "transactional-production"

export type P2TRSignatureFraudWatchtowerStoreProfileProvider = {
  readonly p2trSignatureFraudWatchtowerStoreProfile?: P2TRSignatureFraudWatchtowerIndexingStoreProfile
  readonly p2trSignatureFraudWatchtowerTransactionalStoreID?: string
}

export type P2TRSignatureFraudWatchtowerSharedStoreAssertion = {
  persistence: P2TRWatchtowerChallengeRecordPersistence
  transactionSource: P2TRSignatureFraudWatchtowerTransactionSource
  bridgeLifecycleEventSource: P2TRSignatureFraudWatchtowerBridgeLifecycleEventSource
}

export type P2TRSignatureFraudWatchtowerTransactionCoordinator =
  P2TRSignatureFraudWatchtowerStoreProfileProvider & {
    readonly p2trSignatureFraudWatchtowerAtomicTransactions: true
    assertP2TRSignatureFraudWatchtowerSharedStore(
      dependencies: P2TRSignatureFraudWatchtowerSharedStoreAssertion
    ): void
    runInP2TRSignatureFraudWatchtowerTransaction<T>(
      operation: () => Promise<T>
    ): Promise<T>
    isP2TRSignatureFraudWatchtowerTransactionActive(): boolean
  }

export type P2TRSignatureFraudWatchtowerIdempotentChallengeSubmitter =
  P2TRSignatureFraudChallengeSubmitter & {
    readonly p2trSignatureFraudWatchtowerIdempotentSubmissions: true
  }

export type P2TRSignatureFraudWatchtowerServiceDependencies = {
  bitcoinClient: BitcoinClient
  challengeSubmitter?: P2TRSignatureFraudChallengeSubmitter
  challengeBroadcastReconciler?: P2TRSignatureFraudChallengeBroadcastReconciler
  transactionSource: P2TRSignatureFraudWatchtowerTransactionSource
  bridgeLifecycleEventSource: P2TRSignatureFraudWatchtowerBridgeLifecycleEventSource
  persistence: P2TRWatchtowerChallengeRecordPersistence
  transactionCoordinator?: P2TRSignatureFraudWatchtowerTransactionCoordinator
  alertSink?: P2TRSignatureFraudWatchtowerServiceAlertSink
  logger?: P2TRSignatureFraudWatchtowerServiceLogger
}

export type P2TRSignatureFraudWatchtowerServiceAlertSeverity =
  | "warning"
  | "error"

export type P2TRSignatureFraudWatchtowerServiceAlert =
  | {
      code: "confirmed-transaction-cursor-commit-failed"
      severity: "error"
      message: string
      fields: {
        error: string
        storeId: string
        bridgeIdentifier: string
        cycleStartedAt: string
      }
    }
  | {
      code: "bridge-lifecycle-cursor-commit-failed"
      severity: "error"
      message: string
      fields: {
        error: string
        storeId: string
        bridgeIdentifier: string
        cycleStartedAt: string
      }
    }
  | {
      code: "watchtower-source-failures"
      severity: "error"
      message: string
      fields: {
        sourceFailures: Array<{ source: string; error: string }>
      }
    }
  | {
      code: "watchtower-item-failures"
      severity: "warning"
      message: string
      fields: {
        itemFailures: number
        mempoolFailures: Record<string, unknown>
        confirmedFailures: Record<string, unknown>
        bridgeLifecycleFailures: Record<string, unknown>
      }
    }
  | {
      code: "watchtower-operator-alerts-open"
      severity: "warning"
      message: string
      fields: {
        unresolvedOperatorAlerts: number
      }
    }

export type P2TRSignatureFraudWatchtowerServiceAlertSink = {
  emitAlert(
    alert: P2TRSignatureFraudWatchtowerServiceAlert
  ): void | Promise<void>
}

export type P2TRSignatureFraudWatchtowerServiceLogger = {
  info(message: string, fields?: Record<string, unknown>): void
  warn(message: string, fields?: Record<string, unknown>): void
  error(message: string, fields?: Record<string, unknown>): void
}

export type P2TRSignatureFraudWatchtowerCycleMetrics = {
  replayedRecords: number
  replayedSubmissions: number
  replayedSubmissionAttempts: number
  mempoolObservations: number
  mempoolSubmissions: number
  mempoolSubmissionAttempts: number
  mempoolFailures: number
  confirmedObservations: number
  confirmedSubmissions: number
  confirmedSubmissionAttempts: number
  confirmedFailures: number
  bridgeLifecycleRecords: number
  bridgeLifecycleFailures: number
  bridgeLifecycleIgnored: number
  sourceFailures: number
  totalRecords: number
  unresolvedOperatorAlerts: number
  alertSinkFailures: number
}

export type P2TRSignatureFraudWatchtowerCycleReport = {
  startedAt: string
  completedAt: string
  result: P2TRSignatureFraudWatchtowerIntegratedCycleResult
  metrics: P2TRSignatureFraudWatchtowerCycleMetrics
}
