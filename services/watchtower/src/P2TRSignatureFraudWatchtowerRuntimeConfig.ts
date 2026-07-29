import {
  BitcoinNetwork,
  P2TR_SIGNATURE_FRAUD_SPEND_TYPE_DEPOSIT_SWEEP,
  P2TR_SIGNATURE_FRAUD_SPEND_TYPE_MOVED_FUNDS_SWEEP,
  P2TR_SIGNATURE_FRAUD_SPEND_TYPE_MOVING_FUNDS,
  P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION,
} from "@keep-network/tbtc-v2.ts"
import type {
  P2TRSignatureFraudChallengeSubmissionPolicy,
  P2TRSignatureFraudSpendType,
  P2TRWatchtowerOperatorAlert,
} from "@keep-network/tbtc-v2.ts"

import type { EsploraP2TRSignatureFraudTransactionSourceOptions } from "./EsploraP2TRSignatureFraudTransactionSource.js"
import type {
  EthersP2TRSignatureFraudBridgeLifecycleEventSourceOptions,
  P2TRTimedOutBridgeEventStatus,
} from "./EthersP2TRSignatureFraudBridgeLifecycleEventSource.js"
import type { P2TRSignatureFraudWatchtowerLoopOptions } from "./P2TRSignatureFraudWatchtowerLoop.js"
import type { P2TRSignatureFraudWatchtowerServiceConfig } from "./types.js"

export const DEFAULT_P2TR_SIGNATURE_FRAUD_WATCHTOWER_POLL_INTERVAL_MS = 30000

export const P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV = {
  bridgeChallengeBridgeAddress:
    "P2TR_SIGNATURE_FRAUD_WATCHTOWER_BRIDGE_CHALLENGE_BRIDGE_ADDRESS",
  bridgeChallengeChainID:
    "P2TR_SIGNATURE_FRAUD_WATCHTOWER_BRIDGE_CHALLENGE_CHAIN_ID",
  bridgeIdentifier: "P2TR_SIGNATURE_FRAUD_WATCHTOWER_BRIDGE_IDENTIFIER",
  bridgeLifecycleCanonicalLogVerificationConcurrency:
    "P2TR_SIGNATURE_FRAUD_WATCHTOWER_BRIDGE_LIFECYCLE_VERIFICATION_CONCURRENCY",
  bridgeLifecycleConfirmationDepth:
    "P2TR_SIGNATURE_FRAUD_WATCHTOWER_BRIDGE_LIFECYCLE_CONFIRMATION_DEPTH",
  bridgeLifecycleCursorFilePath:
    "P2TR_SIGNATURE_FRAUD_WATCHTOWER_BRIDGE_LIFECYCLE_CURSOR_FILE",
  bridgeLifecycleCursorOverlapBlocks:
    "P2TR_SIGNATURE_FRAUD_WATCHTOWER_BRIDGE_LIFECYCLE_CURSOR_OVERLAP_BLOCKS",
  bridgeLifecycleFromBlock:
    "P2TR_SIGNATURE_FRAUD_WATCHTOWER_BRIDGE_LIFECYCLE_FROM_BLOCK",
  bridgeLifecycleMaxBlockRange:
    "P2TR_SIGNATURE_FRAUD_WATCHTOWER_BRIDGE_LIFECYCLE_MAX_BLOCK_RANGE",
  bridgeLifecycleRequireCursorBlockHash:
    "P2TR_SIGNATURE_FRAUD_WATCHTOWER_BRIDGE_LIFECYCLE_REQUIRE_CURSOR_BLOCK_HASH",
  bridgeLifecycleTimedOutEventStatus:
    "P2TR_SIGNATURE_FRAUD_WATCHTOWER_BRIDGE_LIFECYCLE_TIMED_OUT_EVENT_STATUS",
  bridgeLifecycleToBlock:
    "P2TR_SIGNATURE_FRAUD_WATCHTOWER_BRIDGE_LIFECYCLE_TO_BLOCK",
  allowFileBackedSubmission:
    "P2TR_SIGNATURE_FRAUD_WATCHTOWER_ALLOW_FILE_BACKED_SUBMISSION",
  continueOnError: "P2TR_SIGNATURE_FRAUD_WATCHTOWER_CONTINUE_ON_ERROR",
  depositScanConcurrency:
    "P2TR_SIGNATURE_FRAUD_WATCHTOWER_DEPOSIT_SCAN_CONCURRENCY",
  esploraBaseUrl: "P2TR_SIGNATURE_FRAUD_WATCHTOWER_ESPLORA_BASE_URL",
  esploraBitcoinNetwork:
    "P2TR_SIGNATURE_FRAUD_WATCHTOWER_ESPLORA_BITCOIN_NETWORK",
  esploraConfirmedPageLimit:
    "P2TR_SIGNATURE_FRAUD_WATCHTOWER_ESPLORA_CONFIRMED_PAGE_LIMIT",
  esploraMaxAttempts: "P2TR_SIGNATURE_FRAUD_WATCHTOWER_ESPLORA_MAX_ATTEMPTS",
  esploraRequestTimeoutMs:
    "P2TR_SIGNATURE_FRAUD_WATCHTOWER_ESPLORA_REQUEST_TIMEOUT_MS",
  esploraRetryDelayMs: "P2TR_SIGNATURE_FRAUD_WATCHTOWER_ESPLORA_RETRY_DELAY_MS",
  maxInputs: "P2TR_SIGNATURE_FRAUD_WATCHTOWER_MAX_INPUTS",
  maxOutputs: "P2TR_SIGNATURE_FRAUD_WATCHTOWER_MAX_OUTPUTS",
  maxRawTransactionBytes:
    "P2TR_SIGNATURE_FRAUD_WATCHTOWER_MAX_RAW_TRANSACTION_BYTES",
  maxScriptPubKeyBytes:
    "P2TR_SIGNATURE_FRAUD_WATCHTOWER_MAX_SCRIPT_PUBKEY_BYTES",
  maxSubmissionAttempts:
    "P2TR_SIGNATURE_FRAUD_WATCHTOWER_MAX_SUBMISSION_ATTEMPTS",
  pollIntervalMs: "P2TR_SIGNATURE_FRAUD_WATCHTOWER_POLL_INTERVAL_MS",
  stateFilePath: "P2TR_SIGNATURE_FRAUD_WATCHTOWER_STATE_FILE",
  submissionAllowedSpendTypes:
    "P2TR_SIGNATURE_FRAUD_WATCHTOWER_SUBMISSION_ALLOWED_SPEND_TYPES",
  submissionAttemptLimitAlertCode:
    "P2TR_SIGNATURE_FRAUD_WATCHTOWER_SUBMISSION_ATTEMPT_LIMIT_ALERT_CODE",
  submissionAttemptLimitAlertMessage:
    "P2TR_SIGNATURE_FRAUD_WATCHTOWER_SUBMISSION_ATTEMPT_LIMIT_ALERT_MESSAGE",
  submitChallenges: "P2TR_SIGNATURE_FRAUD_WATCHTOWER_SUBMIT_CHALLENGES",
  walletIDs: "P2TR_SIGNATURE_FRAUD_WATCHTOWER_WALLET_IDS",
} as const

export type P2TRSignatureFraudWatchtowerRuntimeEnv = Record<
  string,
  string | undefined
>

export type P2TRSignatureFraudWatchtowerBridgeLifecycleRuntimeConfig = Omit<
  EthersP2TRSignatureFraudBridgeLifecycleEventSourceOptions,
  "canonicalLogVerifier" | "scanCursorStore" | "sourceTrustDomainID"
> & {
  scanCursorFilePath?: string
}

export type P2TRSignatureFraudWatchtowerTransactionSourceRuntimeConfig = Omit<
  EsploraP2TRSignatureFraudTransactionSourceOptions,
  "fetchFn" | "taprootDepositRevealSource" | "onDepositScanFailure"
> & {
  esploraBaseUrl?: string
  bitcoinNetwork?: BitcoinNetwork
}

export type P2TRSignatureFraudWatchtowerRuntimeConfig = {
  stateFilePath: string
  bridgeLifecycle: P2TRSignatureFraudWatchtowerBridgeLifecycleRuntimeConfig
  transactionSource: P2TRSignatureFraudWatchtowerTransactionSourceRuntimeConfig
  service: P2TRSignatureFraudWatchtowerServiceConfig
  loop: Pick<
    P2TRSignatureFraudWatchtowerLoopOptions,
    "continueOnError" | "pollIntervalMs"
  >
}

export function loadP2TRSignatureFraudWatchtowerRuntimeConfig(
  env: P2TRSignatureFraudWatchtowerRuntimeEnv = process.env
): P2TRSignatureFraudWatchtowerRuntimeConfig {
  const stateFilePath = readRequiredEnv(
    env,
    P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.stateFilePath
  )
  const registeredWalletIDs = parseWalletIDs(
    readRequiredEnv(env, P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.walletIDs)
  )
  const maxSubmissionAttempts = parseOptionalPositiveIntegerEnv(
    env,
    P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.maxSubmissionAttempts
  )
  const submissionAttemptLimitAlert = parseSubmissionAttemptLimitAlert(
    env,
    maxSubmissionAttempts
  )
  const submitChallenges = parseOptionalBooleanEnv(
    env,
    P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.submitChallenges,
    false
  )
  const allowFileBackedSubmission = parseOptionalBooleanEnv(
    env,
    P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.allowFileBackedSubmission,
    false
  )
  const bridgeLifecycle = parseBridgeLifecycleRuntimeConfig(env)

  validateSubmissionBridgeLifecycleRuntimeConfig(
    submitChallenges,
    bridgeLifecycle,
    allowFileBackedSubmission
  )

  const bridgeChallengeDomain = parseBridgeChallengeDomain(env)
  const payloadBounds = parsePayloadBounds(env)
  const submissionPolicy = parseSubmissionPolicy(env, submitChallenges)

  validateSubmissionServiceRuntimeConfig(submitChallenges, {
    bridgeChallengeDomain,
    payloadBounds,
    maxSubmissionAttempts,
    submissionAttemptLimitAlert,
  })

  return {
    stateFilePath,
    bridgeLifecycle,
    transactionSource: parseTransactionSourceRuntimeConfig(env),
    service: {
      registeredWalletIDs,
      bridgeIdentifier: readOptionalHexEnv(
        env,
        P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeIdentifier
      ),
      bridgeChallengeDomain,
      payloadBounds,
      submissionPolicy,
      maxSubmissionAttempts,
      submissionAttemptLimitAlert,
      submitChallenges,
      indexingStoreProfile: "single-process-rehearsal",
      allowSingleProcessRehearsalSubmission: allowFileBackedSubmission,
    },
    loop: {
      pollIntervalMs: parseOptionalPositiveIntegerEnv(
        env,
        P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.pollIntervalMs,
        DEFAULT_P2TR_SIGNATURE_FRAUD_WATCHTOWER_POLL_INTERVAL_MS
      ),
      continueOnError: parseOptionalBooleanEnv(
        env,
        P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.continueOnError,
        false
      ),
    },
  }
}

function validateSubmissionBridgeLifecycleRuntimeConfig(
  submitChallenges: boolean,
  bridgeLifecycle: P2TRSignatureFraudWatchtowerBridgeLifecycleRuntimeConfig,
  allowFileBackedSubmission: boolean
): void {
  if (!submitChallenges) {
    return
  }

  if (bridgeLifecycle.scanCursorFilePath === undefined) {
    throw new Error(
      `${P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.submitChallenges} requires ${P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeLifecycleCursorFilePath}`
    )
  }

  if (bridgeLifecycle.requireCursorBlockHash !== true) {
    throw new Error(
      `${P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.submitChallenges} requires ${P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeLifecycleRequireCursorBlockHash}=true`
    )
  }

  if (!allowFileBackedSubmission) {
    throw new Error(
      `${P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.submitChallenges} uses bundled file-backed stores and requires ${P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.allowFileBackedSubmission}=true for single-process rehearsal; production submission requires transactional challenge-record and cursor stores`
    )
  }
}

// The approved submission spend types are the env-expressible part of the
// submission policy. The fail-closed spend types (`unclassified`,
// `wallet-closing`, `heartbeat`) are intentionally excluded so an operator
// cannot allowlist a spend type the service rejects as fail-closed.
const approvedSubmissionSpendTypes = new Set<P2TRSignatureFraudSpendType>([
  P2TR_SIGNATURE_FRAUD_SPEND_TYPE_DEPOSIT_SWEEP,
  P2TR_SIGNATURE_FRAUD_SPEND_TYPE_MOVING_FUNDS,
  P2TR_SIGNATURE_FRAUD_SPEND_TYPE_MOVED_FUNDS_SWEEP,
  P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION,
])

function parseSubmissionPolicy(
  env: P2TRSignatureFraudWatchtowerRuntimeEnv,
  submitChallenges: boolean
): P2TRSignatureFraudChallengeSubmissionPolicy | undefined {
  const key = P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.submissionAllowedSpendTypes
  const value = readOptionalEnv(env, key)

  if (!submitChallenges) {
    if (value !== undefined) {
      throw new Error(
        `${key} requires ${P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.submitChallenges}=true`
      )
    }

    return undefined
  }

  if (value === undefined) {
    throw new Error(
      `${P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.submitChallenges} requires ${key}`
    )
  }

  const entries = value.split(",").map((entry) => entry.trim())

  if (entries.some((entry) => entry.length === 0)) {
    throw new Error(`${key} must not contain empty entries`)
  }

  const allowedSpendTypes: P2TRSignatureFraudSpendType[] = []
  const seenSpendTypes = new Set<P2TRSignatureFraudSpendType>()

  for (const entry of entries) {
    const spendType = entry as P2TRSignatureFraudSpendType

    if (!approvedSubmissionSpendTypes.has(spendType)) {
      throw new Error(
        `${key} must contain only approved submission spend types (${[
          ...approvedSubmissionSpendTypes,
        ].join(", ")}); got ${entry}`
      )
    }

    if (!seenSpendTypes.has(spendType)) {
      seenSpendTypes.add(spendType)
      allowedSpendTypes.push(spendType)
    }
  }

  return { allowedSpendTypes }
}

// Enforce the env-owned submission preconditions the service also requires so
// operators get a config-time error that names the missing environment
// variable instead of a later service-constructor failure. The spend-type
// classifier is intentionally not validated here because it is a code-injected
// predicate that cannot be expressed from environment variables.
function validateSubmissionServiceRuntimeConfig(
  submitChallenges: boolean,
  config: {
    bridgeChallengeDomain:
      | { chainID: string; bridgeAddress: string }
      | undefined
    payloadBounds: P2TRSignatureFraudWatchtowerServiceConfig["payloadBounds"]
    maxSubmissionAttempts: number | undefined
    submissionAttemptLimitAlert: P2TRWatchtowerOperatorAlert | undefined
  }
): void {
  if (!submitChallenges) {
    return
  }

  if (config.payloadBounds === undefined) {
    throw new Error(
      `${P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.submitChallenges} requires ${P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.maxRawTransactionBytes}, ${P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.maxInputs}, ${P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.maxOutputs}, and ${P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.maxScriptPubKeyBytes}`
    )
  }

  if (config.bridgeChallengeDomain === undefined) {
    throw new Error(
      `${P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.submitChallenges} requires ${P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeChallengeChainID} and ${P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeChallengeBridgeAddress}`
    )
  }

  if (config.maxSubmissionAttempts === undefined) {
    throw new Error(
      `${P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.submitChallenges} requires ${P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.maxSubmissionAttempts}`
    )
  }

  if (config.submissionAttemptLimitAlert === undefined) {
    throw new Error(
      `${P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.submitChallenges} requires ${P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.submissionAttemptLimitAlertCode} and ${P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.submissionAttemptLimitAlertMessage}`
    )
  }
}

function parseTransactionSourceRuntimeConfig(
  env: P2TRSignatureFraudWatchtowerRuntimeEnv
): P2TRSignatureFraudWatchtowerTransactionSourceRuntimeConfig {
  const esploraBaseUrl = readOptionalEnv(
    env,
    P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.esploraBaseUrl
  )
  const bitcoinNetwork = parseOptionalBitcoinNetworkEnv(env)
  const maxAttempts = parseOptionalPositiveIntegerEnv(
    env,
    P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.esploraMaxAttempts
  )
  const requestTimeoutMs = parseOptionalPositiveIntegerEnv(
    env,
    P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.esploraRequestTimeoutMs
  )
  const retryDelayMs = parseOptionalNonNegativeIntegerEnv(
    env,
    P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.esploraRetryDelayMs
  )
  const confirmedPageLimit = parseOptionalPositiveIntegerEnv(
    env,
    P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.esploraConfirmedPageLimit
  )
  const depositScanConcurrency = parseOptionalPositiveIntegerEnv(
    env,
    P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.depositScanConcurrency
  )
  const configuredOptions = [
    maxAttempts,
    requestTimeoutMs,
    retryDelayMs,
    confirmedPageLimit,
    depositScanConcurrency,
  ]

  if (
    configuredOptions.some((value) => value !== undefined) &&
    (esploraBaseUrl === undefined || bitcoinNetwork === undefined)
  ) {
    throw new Error(
      "P2TR signature-fraud Esplora transaction source options require base URL and Bitcoin network"
    )
  }

  if ((esploraBaseUrl === undefined) !== (bitcoinNetwork === undefined)) {
    throw new Error(
      "P2TR signature-fraud Esplora transaction source requires both base URL and Bitcoin network"
    )
  }

  return {
    esploraBaseUrl,
    bitcoinNetwork,
    maxAttempts,
    requestTimeoutMs,
    retryDelayMs,
    confirmedPageLimit,
    depositScanConcurrency,
  }
}

function parseBridgeLifecycleRuntimeConfig(
  env: P2TRSignatureFraudWatchtowerRuntimeEnv
): P2TRSignatureFraudWatchtowerBridgeLifecycleRuntimeConfig {
  const canonicalLogVerificationConcurrency = parseOptionalPositiveIntegerEnv(
    env,
    P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeLifecycleCanonicalLogVerificationConcurrency
  )
  const scanCursorFilePath = readOptionalEnv(
    env,
    P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeLifecycleCursorFilePath
  )
  const confirmationDepth = parseOptionalNonNegativeIntegerEnv(
    env,
    P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeLifecycleConfirmationDepth
  )
  const maxBlockRange = parseOptionalPositiveIntegerEnv(
    env,
    P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeLifecycleMaxBlockRange
  )
  const cursorOverlapBlocks = parseOptionalNonNegativeIntegerEnv(
    env,
    P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeLifecycleCursorOverlapBlocks
  )
  const requireCursorBlockHash = parseOptionalBooleanEnv(
    env,
    P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeLifecycleRequireCursorBlockHash,
    false
  )
  const fromBlock = parseOptionalNonNegativeIntegerEnv(
    env,
    P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeLifecycleFromBlock
  )
  const toBlock = parseOptionalNonNegativeIntegerEnv(
    env,
    P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeLifecycleToBlock
  )
  const timedOutEventStatus = parseOptionalTimedOutEventStatusEnv(env)

  if (scanCursorFilePath !== undefined && maxBlockRange === undefined) {
    throw new Error(
      `${P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeLifecycleMaxBlockRange} must be set when configuring a Bridge lifecycle cursor file`
    )
  }

  if (scanCursorFilePath !== undefined && fromBlock !== undefined) {
    throw new Error(
      `${P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeLifecycleCursorFilePath} cannot be combined with ${P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeLifecycleFromBlock}`
    )
  }

  if (
    scanCursorFilePath !== undefined &&
    maxBlockRange !== undefined &&
    cursorOverlapBlocks !== undefined &&
    cursorOverlapBlocks >= maxBlockRange
  ) {
    throw new Error(
      `${P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeLifecycleCursorOverlapBlocks} must be less than ${P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeLifecycleMaxBlockRange} when configuring a Bridge lifecycle cursor file`
    )
  }

  if (
    scanCursorFilePath !== undefined &&
    toBlock === undefined &&
    confirmationDepth === undefined
  ) {
    throw new Error(
      `${P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeLifecycleCursorFilePath} requires ${P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeLifecycleToBlock} or ${P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeLifecycleConfirmationDepth}`
    )
  }

  if (requireCursorBlockHash && scanCursorFilePath === undefined) {
    throw new Error(
      `${P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeLifecycleRequireCursorBlockHash} requires ${P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeLifecycleCursorFilePath}`
    )
  }

  return {
    canonicalLogVerificationConcurrency,
    scanCursorFilePath,
    confirmationDepth,
    maxBlockRange,
    cursorOverlapBlocks,
    ...(requireCursorBlockHash ? { requireCursorBlockHash } : {}),
    fromBlock,
    toBlock,
    timedOutEventStatus,
  }
}

function parseWalletIDs(rawWalletIDs: string): string[] {
  const walletIDs = rawWalletIDs.split(",").map((walletID) => walletID.trim())

  if (walletIDs.some((walletID) => walletID.length === 0)) {
    throw new Error(
      `${P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.walletIDs} must not contain empty entries`
    )
  }

  const normalizedWalletIDs = walletIDs.map((walletID) =>
    normalizeBytes32Hex(walletID, "wallet ID")
  )
  const uniqueWalletIDs = new Set(normalizedWalletIDs)

  if (uniqueWalletIDs.size !== normalizedWalletIDs.length) {
    throw new Error(
      `${P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.walletIDs} must not contain duplicates`
    )
  }

  return normalizedWalletIDs
}

function parseSubmissionAttemptLimitAlert(
  env: P2TRSignatureFraudWatchtowerRuntimeEnv,
  maxSubmissionAttempts: number | undefined
): P2TRWatchtowerOperatorAlert | undefined {
  const code = readOptionalEnv(
    env,
    P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.submissionAttemptLimitAlertCode
  )
  const message = readOptionalEnv(
    env,
    P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.submissionAttemptLimitAlertMessage
  )

  if (code === undefined && message === undefined) {
    return undefined
  }

  if (code === undefined || message === undefined) {
    throw new Error(
      "P2TR signature-fraud watchtower submission-attempt alert requires both code and message"
    )
  }

  if (maxSubmissionAttempts === undefined) {
    throw new Error(
      `${P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.maxSubmissionAttempts} must be set when configuring a submission-attempt alert`
    )
  }

  return { code, message }
}

function parseBridgeChallengeDomain(
  env: P2TRSignatureFraudWatchtowerRuntimeEnv
): { chainID: string; bridgeAddress: string } | undefined {
  const chainID = readOptionalEnv(
    env,
    P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeChallengeChainID
  )
  const bridgeAddress = readOptionalEnv(
    env,
    P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeChallengeBridgeAddress
  )

  if (chainID === undefined && bridgeAddress === undefined) {
    return undefined
  }

  if (chainID === undefined || bridgeAddress === undefined) {
    throw new Error(
      "P2TR signature-fraud Bridge challenge domain requires both chain ID and Bridge address"
    )
  }

  return {
    chainID: normalizePositiveIntegerString(
      chainID,
      P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeChallengeChainID
    ),
    bridgeAddress: normalizeAddressHex(
      bridgeAddress,
      P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeChallengeBridgeAddress
    ),
  }
}

function parsePayloadBounds(
  env: P2TRSignatureFraudWatchtowerRuntimeEnv
): P2TRSignatureFraudWatchtowerServiceConfig["payloadBounds"] {
  const keys = [
    P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.maxRawTransactionBytes,
    P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.maxInputs,
    P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.maxOutputs,
    P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.maxScriptPubKeyBytes,
  ] as const
  const providedKeys = keys.filter(
    (key) => readOptionalEnv(env, key) !== undefined
  )

  if (providedKeys.length === 0) {
    return undefined
  }

  if (providedKeys.length !== keys.length) {
    throw new Error(
      "P2TR signature-fraud payload bounds require raw transaction, input, output, and scriptPubKey byte limits"
    )
  }

  return {
    maxRawTransactionBytes: parseOptionalPositiveIntegerEnv(
      env,
      P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.maxRawTransactionBytes
    ),
    maxInputs: parseOptionalPositiveIntegerEnv(
      env,
      P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.maxInputs
    ),
    maxOutputs: parseOptionalPositiveIntegerEnv(
      env,
      P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.maxOutputs
    ),
    maxScriptPubKeyBytes: parseOptionalPositiveIntegerEnv(
      env,
      P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.maxScriptPubKeyBytes
    ),
  }
}

function parseOptionalPositiveIntegerEnv(
  env: P2TRSignatureFraudWatchtowerRuntimeEnv,
  key: string,
  defaultValue: number
): number
function parseOptionalPositiveIntegerEnv(
  env: P2TRSignatureFraudWatchtowerRuntimeEnv,
  key: string
): number | undefined
function parseOptionalPositiveIntegerEnv(
  env: P2TRSignatureFraudWatchtowerRuntimeEnv,
  key: string,
  defaultValue?: number
): number | undefined {
  const value = readOptionalEnv(env, key)

  if (value === undefined) {
    return defaultValue
  }

  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`${key} must be a positive integer`)
  }

  const parsedValue = Number(value)
  if (!Number.isSafeInteger(parsedValue) || parsedValue <= 0) {
    throw new Error(`${key} must be a positive integer`)
  }

  return parsedValue
}

function parseOptionalNonNegativeIntegerEnv(
  env: P2TRSignatureFraudWatchtowerRuntimeEnv,
  key: string
): number | undefined {
  const value = readOptionalEnv(env, key)

  if (value === undefined) {
    return undefined
  }

  if (!/^[0-9]+$/.test(value)) {
    throw new Error(`${key} must be a non-negative integer`)
  }

  const parsedValue = Number(value)
  if (!Number.isSafeInteger(parsedValue) || parsedValue < 0) {
    throw new Error(`${key} must be a non-negative integer`)
  }

  return parsedValue
}

function parseOptionalTimedOutEventStatusEnv(
  env: P2TRSignatureFraudWatchtowerRuntimeEnv
): P2TRTimedOutBridgeEventStatus | undefined {
  const key =
    P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeLifecycleTimedOutEventStatus
  const value = readOptionalEnv(env, key)

  if (value === undefined) {
    return undefined
  }

  if (value !== "slashed" && value !== "rewarded") {
    throw new Error(`${key} must be slashed or rewarded`)
  }

  return value
}

function parseOptionalBitcoinNetworkEnv(
  env: P2TRSignatureFraudWatchtowerRuntimeEnv
): BitcoinNetwork | undefined {
  const key = P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.esploraBitcoinNetwork
  const value = readOptionalEnv(env, key)

  if (value === undefined) {
    return undefined
  }

  switch (value) {
    case BitcoinNetwork.Mainnet:
    case BitcoinNetwork.Testnet:
    case BitcoinNetwork.Testnet4:
      return value
    default:
      throw new Error(`${key} must be mainnet, testnet, or testnet4`)
  }
}

function parseOptionalBooleanEnv(
  env: P2TRSignatureFraudWatchtowerRuntimeEnv,
  key: string,
  defaultValue: boolean
): boolean {
  const value = readOptionalEnv(env, key)

  if (value === undefined) {
    return defaultValue
  }

  switch (value.toLowerCase()) {
    case "false":
      return false
    case "true":
      return true
    default:
      throw new Error(`${key} must be true or false`)
  }
}

function readRequiredEnv(
  env: P2TRSignatureFraudWatchtowerRuntimeEnv,
  key: string
): string {
  const value = readOptionalEnv(env, key)

  if (value === undefined) {
    throw new Error(`${key} is required`)
  }

  return value
}

function readOptionalEnv(
  env: P2TRSignatureFraudWatchtowerRuntimeEnv,
  key: string
): string | undefined {
  const value = env[key]?.trim()

  return value === undefined || value.length === 0 ? undefined : value
}

function readOptionalHexEnv(
  env: P2TRSignatureFraudWatchtowerRuntimeEnv,
  key: string
): string | undefined {
  const value = readOptionalEnv(env, key)

  if (value === undefined) {
    return undefined
  }

  if (!/^0x[0-9a-fA-F]+$/.test(value) || value.length % 2 !== 0) {
    throw new Error(`${key} must be a 0x-prefixed hex string`)
  }

  return value.toLowerCase()
}

function normalizePositiveIntegerString(value: string, key: string): string {
  if (!/^[0-9]+$/.test(value) || BigInt(value) <= 0n) {
    throw new Error(`${key} must be a positive integer`)
  }

  return value
}

function normalizeAddressHex(value: string, key: string): string {
  if (!/^0x[0-9a-fA-F]{40}$/.test(value)) {
    throw new Error(`${key} must be a 0x-prefixed Ethereum address`)
  }

  if (/^0x0{40}$/.test(value.toLowerCase())) {
    throw new Error(`${key} must be non-zero`)
  }

  return value.toLowerCase()
}

function normalizeBytes32Hex(value: string, label: string): string {
  const normalizedValue = value.startsWith("0x") ? value : `0x${value}`

  if (!/^0x[0-9a-fA-F]{64}$/.test(normalizedValue)) {
    throw new Error(`P2TR signature-fraud watchtower ${label} must be 32 bytes`)
  }

  return normalizedValue.toLowerCase()
}
