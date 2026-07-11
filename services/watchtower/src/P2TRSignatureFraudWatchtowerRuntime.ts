import type {
  P2TRSignatureFraudChallengeSubmissionPolicy,
  P2TRSignatureFraudSpendTypeClassifier,
} from "@keep-network/tbtc-v2.ts"

import { EthersP2TRSignatureFraudBridgeLifecycleEventSource } from "./EthersP2TRSignatureFraudBridgeLifecycleEventSource.js"
import { EsploraP2TRSignatureFraudTransactionSource } from "./EsploraP2TRSignatureFraudTransactionSource.js"
import { FileBackedP2TRWatchtowerChallengeRecordPersistence } from "./FileBackedP2TRWatchtowerChallengeRecordPersistence.js"
import { FileBackedP2TRBridgeLifecycleScanCursorStore } from "./FileBackedP2TRBridgeLifecycleScanCursorStore.js"
import type { P2TREthersBridgeLifecycleContract } from "./EthersP2TRSignatureFraudBridgeLifecycleEventSource.js"
import type {
  P2TRDepositScanFailure,
  P2TREsploraFetch,
  P2TRTaprootDepositRevealSource,
} from "./EsploraP2TRSignatureFraudTransactionSource.js"
import type { P2TRSignatureFraudWatchtowerLoopOptions } from "./P2TRSignatureFraudWatchtowerLoop.js"
import { P2TRSignatureFraudWatchtowerService } from "./P2TRSignatureFraudWatchtowerService.js"
import type {
  P2TRSignatureFraudWatchtowerBridgeLifecycleRuntimeConfig,
  P2TRSignatureFraudWatchtowerRuntimeConfig,
} from "./P2TRSignatureFraudWatchtowerRuntimeConfig.js"
import type { P2TRSignatureFraudWatchtowerServiceDependencies } from "./types.js"

export type P2TRSignatureFraudWatchtowerRuntimeDependencies = Omit<
  P2TRSignatureFraudWatchtowerServiceDependencies,
  "persistence"
>

export type P2TRSignatureFraudWatchtowerRuntime = {
  service: P2TRSignatureFraudWatchtowerService
  loopOptions: Pick<
    P2TRSignatureFraudWatchtowerLoopOptions,
    "continueOnError" | "pollIntervalMs"
  >
}

export type P2TRSignatureFraudWatchtowerEsploraRuntimeOptions = {
  taprootDepositRevealSource: P2TRTaprootDepositRevealSource
  onDepositScanFailure: (failure: P2TRDepositScanFailure) => void
  fetchFn?: P2TREsploraFetch
}

export type P2TRSignatureFraudWatchtowerRuntimeSubmissionOptions = {
  spendTypeClassifier?: P2TRSignatureFraudSpendTypeClassifier
  submissionPolicy?: P2TRSignatureFraudChallengeSubmissionPolicy
}

export function createFileBackedP2TRSignatureFraudWatchtowerRuntime(
  config: P2TRSignatureFraudWatchtowerRuntimeConfig,
  dependencies: P2TRSignatureFraudWatchtowerRuntimeDependencies,
  options: P2TRSignatureFraudWatchtowerRuntimeSubmissionOptions = {}
): P2TRSignatureFraudWatchtowerRuntime {
  const spendTypeClassifier =
    options.spendTypeClassifier ?? config.service.spendTypeClassifier
  const submissionPolicy =
    options.submissionPolicy ?? config.service.submissionPolicy

  // The spend-type classifier is a code predicate that cannot be synthesized
  // from environment variables. Fail closed here so a submission-mode env
  // configuration cannot silently start without an injected classifier.
  if (
    config.service.submitChallenges === true &&
    spendTypeClassifier === undefined
  ) {
    throw new Error(
      "P2TR signature-fraud watchtower submission mode requires an injected spend-type classifier; the environment-backed runtime cannot synthesize one from env vars"
    )
  }

  return {
    service: new P2TRSignatureFraudWatchtowerService(
      {
        ...config.service,
        spendTypeClassifier,
        submissionPolicy,
      },
      {
        ...dependencies,
        persistence: new FileBackedP2TRWatchtowerChallengeRecordPersistence(
          config.stateFilePath
        ),
      }
    ),
    loopOptions: config.loop,
  }
}

export function createFileBackedP2TRBridgeLifecycleEventSource(
  p2trSignatureFraudRouter: P2TREthersBridgeLifecycleContract,
  bridge: P2TREthersBridgeLifecycleContract,
  config: P2TRSignatureFraudWatchtowerBridgeLifecycleRuntimeConfig
): EthersP2TRSignatureFraudBridgeLifecycleEventSource {
  const { scanCursorFilePath, ...options } = config

  return new EthersP2TRSignatureFraudBridgeLifecycleEventSource(
    p2trSignatureFraudRouter,
    bridge,
    {
      ...options,
      scanCursorStore:
        scanCursorFilePath === undefined
          ? undefined
          : new FileBackedP2TRBridgeLifecycleScanCursorStore(
              scanCursorFilePath
            ),
    }
  )
}

export function createEsploraP2TRTransactionSourceFromRuntimeConfig(
  config: P2TRSignatureFraudWatchtowerRuntimeConfig,
  options: P2TRSignatureFraudWatchtowerEsploraRuntimeOptions
): EsploraP2TRSignatureFraudTransactionSource {
  const { esploraBaseUrl, bitcoinNetwork, ...sourceOptions } =
    config.transactionSource

  if (esploraBaseUrl === undefined || bitcoinNetwork === undefined) {
    throw new Error(
      "P2TR signature-fraud Esplora transaction source requires base URL and Bitcoin network"
    )
  }

  return new EsploraP2TRSignatureFraudTransactionSource(
    esploraBaseUrl,
    bitcoinNetwork,
    config.service.registeredWalletIDs,
    {
      ...sourceOptions,
      taprootDepositRevealSource: options.taprootDepositRevealSource,
      onDepositScanFailure: options.onDepositScanFailure,
      fetchFn: options.fetchFn,
    }
  )
}
