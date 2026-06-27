import assert from "assert/strict"
import test from "node:test"

import {
  BitcoinNetwork,
  P2TR_SIGNATURE_FRAUD_SPEND_TYPE_DEPOSIT_SWEEP,
  P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION,
} from "@keep-network/tbtc-v2.ts"

import {
  DEFAULT_P2TR_SIGNATURE_FRAUD_WATCHTOWER_POLL_INTERVAL_MS,
  P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV,
  loadP2TRSignatureFraudWatchtowerRuntimeConfig,
} from "../src/index.js"
import type { P2TRSignatureFraudWatchtowerRuntimeEnv } from "../src/index.js"

const baseEnv = (): P2TRSignatureFraudWatchtowerRuntimeEnv => ({
  [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.stateFilePath]:
    "/var/lib/tbtc/p2tr-watchtower.json",
  [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.walletIDs]: `0x${"AB".repeat(32)}`,
})
const bridgeLifecycleRequireCursorBlockHashEnv =
  P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeLifecycleRequireCursorBlockHash

// A complete, valid submission-mode environment. Negative cases override a
// single field so each assertion isolates the precondition under test.
const submissionEnv = (): P2TRSignatureFraudWatchtowerRuntimeEnv => ({
  ...baseEnv(),
  [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.submitChallenges]: "true",
  [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.allowFileBackedSubmission]: "true",
  [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.submissionAllowedSpendTypes]:
    "redemption",
  [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeLifecycleCursorFilePath]:
    "/var/lib/tbtc/p2tr-bridge-lifecycle-cursor.json",
  [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeLifecycleConfirmationDepth]: "12",
  [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeLifecycleMaxBlockRange]: "5000",
  [bridgeLifecycleRequireCursorBlockHashEnv]: "true",
  [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeChallengeChainID]: "11155111",
  [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeChallengeBridgeAddress]:
    "0x1111111111111111111111111111111111111111",
  [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.maxRawTransactionBytes]: "10000",
  [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.maxInputs]: "2",
  [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.maxOutputs]: "2",
  [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.maxScriptPubKeyBytes]: "34",
  [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.maxSubmissionAttempts]: "3",
  [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.submissionAttemptLimitAlertCode]:
    "submission-attempt-limit",
  [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.submissionAttemptLimitAlertMessage]:
    "manual intervention required",
})

test("loads required watchtower runtime config with safe defaults", () => {
  const config = loadP2TRSignatureFraudWatchtowerRuntimeConfig(baseEnv())

  assert.equal(config.stateFilePath, "/var/lib/tbtc/p2tr-watchtower.json")
  assert.deepEqual(config.service.registeredWalletIDs, [`0x${"ab".repeat(32)}`])
  assert.equal(config.service.bridgeIdentifier, undefined)
  assert.equal(config.service.bridgeChallengeDomain, undefined)
  assert.equal(config.service.maxSubmissionAttempts, undefined)
  assert.equal(config.service.submissionAttemptLimitAlert, undefined)
  assert.equal(config.service.submissionPolicy, undefined)
  assert.equal(config.service.submitChallenges, false)
  assert.equal(config.service.indexingStoreProfile, "single-process-rehearsal")
  assert.equal(config.service.allowSingleProcessRehearsalSubmission, false)
  assert.deepEqual(config.bridgeLifecycle, {
    scanCursorFilePath: undefined,
    confirmationDepth: undefined,
    maxBlockRange: undefined,
    cursorOverlapBlocks: undefined,
    fromBlock: undefined,
    toBlock: undefined,
    timedOutEventStatus: undefined,
  })
  assert.deepEqual(config.transactionSource, {
    esploraBaseUrl: undefined,
    bitcoinNetwork: undefined,
    maxAttempts: undefined,
    requestTimeoutMs: undefined,
    retryDelayMs: undefined,
    confirmedPageLimit: undefined,
  })
  assert.deepEqual(config.loop, {
    pollIntervalMs: DEFAULT_P2TR_SIGNATURE_FRAUD_WATCHTOWER_POLL_INTERVAL_MS,
    continueOnError: false,
  })
})

test("loads explicit watchtower runtime config values", () => {
  const config = loadP2TRSignatureFraudWatchtowerRuntimeConfig({
    ...baseEnv(),
    [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.walletIDs]: [
      `0x${"11".repeat(32)}`,
      "22".repeat(32),
    ].join(","),
    [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeIdentifier]: "0xAABB",
    [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeChallengeChainID]: "11155111",
    [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeChallengeBridgeAddress]:
      "0x1111111111111111111111111111111111111111",
    [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeLifecycleCursorFilePath]:
      "/var/lib/tbtc/p2tr-bridge-lifecycle-cursor.json",
    [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeLifecycleConfirmationDepth]:
      "12",
    [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeLifecycleMaxBlockRange]: "5000",
    [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeLifecycleCursorOverlapBlocks]:
      "6",
    [bridgeLifecycleRequireCursorBlockHashEnv]: "true",
    [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeLifecycleToBlock]: "1000",
    [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeLifecycleTimedOutEventStatus]:
      "rewarded",
    [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.allowFileBackedSubmission]: "true",
    [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.esploraBaseUrl]:
      "https://esplora.test",
    [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.esploraBitcoinNetwork]: "testnet",
    [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.esploraMaxAttempts]: "4",
    [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.esploraRequestTimeoutMs]: "6000",
    [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.esploraRetryDelayMs]: "0",
    [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.esploraConfirmedPageLimit]: "3",
    [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.pollIntervalMs]: "45000",
    [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.continueOnError]: "true",
    [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.submitChallenges]: "true",
    [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.submissionAllowedSpendTypes]:
      "redemption, deposit-sweep, redemption",
    [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.maxRawTransactionBytes]: "10000",
    [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.maxInputs]: "2",
    [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.maxOutputs]: "2",
    [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.maxScriptPubKeyBytes]: "34",
    [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.maxSubmissionAttempts]: "3",
    [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.submissionAttemptLimitAlertCode]:
      "submission-attempt-limit",
    [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.submissionAttemptLimitAlertMessage]:
      "manual intervention required",
  })

  assert.deepEqual(config.service.registeredWalletIDs, [
    `0x${"11".repeat(32)}`,
    `0x${"22".repeat(32)}`,
  ])
  assert.equal(config.service.bridgeIdentifier, "0xaabb")
  assert.deepEqual(config.service.bridgeChallengeDomain, {
    chainID: "11155111",
    bridgeAddress: "0x1111111111111111111111111111111111111111",
  })
  assert.deepEqual(config.bridgeLifecycle, {
    scanCursorFilePath: "/var/lib/tbtc/p2tr-bridge-lifecycle-cursor.json",
    confirmationDepth: 12,
    maxBlockRange: 5000,
    cursorOverlapBlocks: 6,
    requireCursorBlockHash: true,
    fromBlock: undefined,
    toBlock: 1000,
    timedOutEventStatus: "rewarded",
  })
  assert.deepEqual(config.transactionSource, {
    esploraBaseUrl: "https://esplora.test",
    bitcoinNetwork: BitcoinNetwork.Testnet,
    maxAttempts: 4,
    requestTimeoutMs: 6000,
    retryDelayMs: 0,
    confirmedPageLimit: 3,
  })
  assert.equal(config.service.maxSubmissionAttempts, 3)
  assert.equal(config.service.submitChallenges, true)
  assert.equal(config.service.indexingStoreProfile, "single-process-rehearsal")
  assert.equal(config.service.allowSingleProcessRehearsalSubmission, true)
  assert.deepEqual(config.service.payloadBounds, {
    maxRawTransactionBytes: 10000,
    maxInputs: 2,
    maxOutputs: 2,
    maxScriptPubKeyBytes: 34,
  })
  assert.deepEqual(config.service.submissionAttemptLimitAlert, {
    code: "submission-attempt-limit",
    message: "manual intervention required",
  })
  assert.deepEqual(config.service.submissionPolicy, {
    allowedSpendTypes: [
      P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION,
      P2TR_SIGNATURE_FRAUD_SPEND_TYPE_DEPOSIT_SWEEP,
    ],
  })
  assert.deepEqual(config.loop, {
    pollIntervalMs: 45000,
    continueOnError: true,
  })
})

test("validates the submission spend-type policy environment variable", () => {
  assert.doesNotThrow(() =>
    loadP2TRSignatureFraudWatchtowerRuntimeConfig(submissionEnv())
  )

  assert.throws(
    () =>
      loadP2TRSignatureFraudWatchtowerRuntimeConfig({
        ...submissionEnv(),
        [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.submissionAllowedSpendTypes]:
          undefined,
      }),
    /SUBMIT_CHALLENGES requires .*SUBMISSION_ALLOWED_SPEND_TYPES/
  )

  assert.throws(
    () =>
      loadP2TRSignatureFraudWatchtowerRuntimeConfig({
        ...baseEnv(),
        [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.submissionAllowedSpendTypes]:
          "redemption",
      }),
    /SUBMISSION_ALLOWED_SPEND_TYPES requires .*SUBMIT_CHALLENGES=true/
  )

  assert.throws(
    () =>
      loadP2TRSignatureFraudWatchtowerRuntimeConfig({
        ...submissionEnv(),
        [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.submissionAllowedSpendTypes]:
          "redemption,,deposit-sweep",
      }),
    /SUBMISSION_ALLOWED_SPEND_TYPES must not contain empty entries/
  )

  assert.throws(
    () =>
      loadP2TRSignatureFraudWatchtowerRuntimeConfig({
        ...submissionEnv(),
        [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.submissionAllowedSpendTypes]:
          "heartbeat",
      }),
    /SUBMISSION_ALLOWED_SPEND_TYPES must contain only approved submission spend types/
  )

  assert.throws(
    () =>
      loadP2TRSignatureFraudWatchtowerRuntimeConfig({
        ...submissionEnv(),
        [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.submissionAllowedSpendTypes]:
          "not-a-real-spend-type",
      }),
    /SUBMISSION_ALLOWED_SPEND_TYPES must contain only approved submission spend types/
  )
})

test("rejects unsafe watchtower runtime config before service startup", () => {
  assert.throws(
    () =>
      loadP2TRSignatureFraudWatchtowerRuntimeConfig({
        [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.walletIDs]: `0x${"11".repeat(32)}`,
      }),
    /STATE_FILE is required/
  )

  assert.throws(
    () =>
      loadP2TRSignatureFraudWatchtowerRuntimeConfig({
        ...baseEnv(),
        [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.walletIDs]: `0x${"11".repeat(31)}`,
      }),
    /wallet ID must be 32 bytes/
  )

  assert.throws(
    () =>
      loadP2TRSignatureFraudWatchtowerRuntimeConfig({
        ...baseEnv(),
        [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.walletIDs]: [
          `0x${"11".repeat(32)}`,
          `0x${"11".repeat(32)}`,
        ].join(","),
      }),
    /must not contain duplicates/
  )

  assert.throws(
    () =>
      loadP2TRSignatureFraudWatchtowerRuntimeConfig({
        ...baseEnv(),
        [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.pollIntervalMs]: "0",
      }),
    /POLL_INTERVAL_MS must be a positive integer/
  )

  assert.throws(
    () =>
      loadP2TRSignatureFraudWatchtowerRuntimeConfig({
        ...baseEnv(),
        [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.continueOnError]: "yes",
      }),
    /CONTINUE_ON_ERROR must be true or false/
  )

  assert.throws(
    () =>
      loadP2TRSignatureFraudWatchtowerRuntimeConfig({
        ...baseEnv(),
        [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.submitChallenges]: "yes",
      }),
    /SUBMIT_CHALLENGES must be true or false/
  )

  assert.throws(
    () =>
      loadP2TRSignatureFraudWatchtowerRuntimeConfig({
        ...baseEnv(),
        [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.submitChallenges]: "true",
      }),
    /SUBMIT_CHALLENGES requires .*BRIDGE_LIFECYCLE_CURSOR_FILE/
  )

  assert.throws(
    () =>
      loadP2TRSignatureFraudWatchtowerRuntimeConfig({
        ...baseEnv(),
        [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.submitChallenges]: "true",
        [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeLifecycleCursorFilePath]:
          "/var/lib/tbtc/p2tr-bridge-lifecycle-cursor.json",
        [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeLifecycleConfirmationDepth]:
          "12",
        [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeLifecycleMaxBlockRange]:
          "5000",
      }),
    /SUBMIT_CHALLENGES requires .*BRIDGE_LIFECYCLE_REQUIRE_CURSOR_BLOCK_HASH=true/
  )

  assert.throws(
    () =>
      loadP2TRSignatureFraudWatchtowerRuntimeConfig({
        ...baseEnv(),
        [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.submitChallenges]: "true",
        [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeLifecycleCursorFilePath]:
          "/var/lib/tbtc/p2tr-bridge-lifecycle-cursor.json",
        [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeLifecycleConfirmationDepth]:
          "12",
        [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeLifecycleMaxBlockRange]:
          "5000",
        [bridgeLifecycleRequireCursorBlockHashEnv]: "true",
      }),
    /ALLOW_FILE_BACKED_SUBMISSION=true.*production submission requires transactional challenge-record and cursor stores/
  )

  assert.throws(
    () =>
      loadP2TRSignatureFraudWatchtowerRuntimeConfig({
        ...baseEnv(),
        [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.maxInputs]: "2",
      }),
    /payload bounds require raw transaction, input, output, and scriptPubKey byte limits/
  )

  assert.throws(
    () =>
      loadP2TRSignatureFraudWatchtowerRuntimeConfig({
        ...baseEnv(),
        [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.maxRawTransactionBytes]: "10000",
        [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.maxInputs]: "0",
        [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.maxOutputs]: "2",
        [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.maxScriptPubKeyBytes]: "34",
      }),
    /MAX_INPUTS must be a positive integer/
  )

  assert.throws(
    () =>
      loadP2TRSignatureFraudWatchtowerRuntimeConfig({
        ...baseEnv(),
        [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeIdentifier]:
          "bridge-mainnet",
      }),
    /BRIDGE_IDENTIFIER must be a 0x-prefixed hex string/
  )

  assert.throws(
    () =>
      loadP2TRSignatureFraudWatchtowerRuntimeConfig({
        ...baseEnv(),
        [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeChallengeChainID]: "1",
      }),
    /requires both chain ID and Bridge address/
  )

  assert.throws(
    () =>
      loadP2TRSignatureFraudWatchtowerRuntimeConfig({
        ...baseEnv(),
        [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeChallengeChainID]: "0",
        [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeChallengeBridgeAddress]:
          "0x1111111111111111111111111111111111111111",
      }),
    /BRIDGE_CHALLENGE_CHAIN_ID must be a positive integer/
  )

  assert.throws(
    () =>
      loadP2TRSignatureFraudWatchtowerRuntimeConfig({
        ...baseEnv(),
        [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeChallengeChainID]: "1",
        [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeChallengeBridgeAddress]:
          "0x0000000000000000000000000000000000000000",
      }),
    /BRIDGE_CHALLENGE_BRIDGE_ADDRESS must be non-zero/
  )

  assert.throws(
    () =>
      loadP2TRSignatureFraudWatchtowerRuntimeConfig({
        ...baseEnv(),
        [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeChallengeChainID]: "1",
        [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeChallengeBridgeAddress]:
          "0x1234",
      }),
    /BRIDGE_CHALLENGE_BRIDGE_ADDRESS must be a 0x-prefixed Ethereum address/
  )

  assert.throws(
    () =>
      loadP2TRSignatureFraudWatchtowerRuntimeConfig({
        ...baseEnv(),
        [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.submissionAttemptLimitAlertCode]:
          "submission-attempt-limit",
        [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.submissionAttemptLimitAlertMessage]:
          "manual intervention required",
      }),
    /MAX_SUBMISSION_ATTEMPTS must be set/
  )

  assert.throws(
    () =>
      loadP2TRSignatureFraudWatchtowerRuntimeConfig({
        ...baseEnv(),
        [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeLifecycleConfirmationDepth]:
          "-1",
      }),
    /BRIDGE_LIFECYCLE_CONFIRMATION_DEPTH must be a non-negative integer/
  )

  assert.throws(
    () =>
      loadP2TRSignatureFraudWatchtowerRuntimeConfig({
        ...baseEnv(),
        [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeLifecycleCursorFilePath]:
          "/var/lib/tbtc/p2tr-bridge-lifecycle-cursor.json",
        [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeLifecycleConfirmationDepth]:
          "12",
      }),
    /BRIDGE_LIFECYCLE_MAX_BLOCK_RANGE must be set/
  )

  assert.throws(
    () =>
      loadP2TRSignatureFraudWatchtowerRuntimeConfig({
        ...baseEnv(),
        [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeLifecycleCursorFilePath]:
          "/var/lib/tbtc/p2tr-bridge-lifecycle-cursor.json",
        [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeLifecycleConfirmationDepth]:
          "12",
        [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeLifecycleMaxBlockRange]:
          "5000",
        [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeLifecycleFromBlock]: "100",
      }),
    /BRIDGE_LIFECYCLE_CURSOR_FILE cannot be combined with .*BRIDGE_LIFECYCLE_FROM_BLOCK/
  )

  assert.throws(
    () =>
      loadP2TRSignatureFraudWatchtowerRuntimeConfig({
        ...baseEnv(),
        [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeLifecycleCursorFilePath]:
          "/var/lib/tbtc/p2tr-bridge-lifecycle-cursor.json",
        [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeLifecycleConfirmationDepth]:
          "12",
        [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeLifecycleMaxBlockRange]:
          "5000",
        [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeLifecycleCursorOverlapBlocks]:
          "5000",
      }),
    /BRIDGE_LIFECYCLE_CURSOR_OVERLAP_BLOCKS must be less than .*BRIDGE_LIFECYCLE_MAX_BLOCK_RANGE/
  )

  assert.throws(
    () =>
      loadP2TRSignatureFraudWatchtowerRuntimeConfig({
        ...baseEnv(),
        [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeLifecycleCursorFilePath]:
          "/var/lib/tbtc/p2tr-bridge-lifecycle-cursor.json",
        [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeLifecycleMaxBlockRange]:
          "5000",
      }),
    /BRIDGE_LIFECYCLE_CURSOR_FILE requires/
  )

  assert.throws(
    () =>
      loadP2TRSignatureFraudWatchtowerRuntimeConfig({
        ...baseEnv(),
        [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.bridgeLifecycleTimedOutEventStatus]:
          "timeout",
      }),
    /BRIDGE_LIFECYCLE_TIMED_OUT_EVENT_STATUS must be slashed or rewarded/
  )

  assert.throws(
    () =>
      loadP2TRSignatureFraudWatchtowerRuntimeConfig({
        ...baseEnv(),
        [bridgeLifecycleRequireCursorBlockHashEnv]: "yes",
      }),
    /BRIDGE_LIFECYCLE_REQUIRE_CURSOR_BLOCK_HASH must be true or false/
  )

  assert.throws(
    () =>
      loadP2TRSignatureFraudWatchtowerRuntimeConfig({
        ...baseEnv(),
        [bridgeLifecycleRequireCursorBlockHashEnv]: "true",
      }),
    /BRIDGE_LIFECYCLE_REQUIRE_CURSOR_BLOCK_HASH requires .*BRIDGE_LIFECYCLE_CURSOR_FILE/
  )

  assert.throws(
    () =>
      loadP2TRSignatureFraudWatchtowerRuntimeConfig({
        ...baseEnv(),
        [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.esploraBaseUrl]:
          "https://esplora.test",
      }),
    /Esplora transaction source requires both base URL and Bitcoin network/
  )

  assert.throws(
    () =>
      loadP2TRSignatureFraudWatchtowerRuntimeConfig({
        ...baseEnv(),
        [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.esploraBitcoinNetwork]: "regtest",
      }),
    /ESPLORA_BITCOIN_NETWORK must be mainnet or testnet/
  )

  assert.throws(
    () =>
      loadP2TRSignatureFraudWatchtowerRuntimeConfig({
        ...baseEnv(),
        [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.esploraMaxAttempts]: "2",
      }),
    /Esplora transaction source options require base URL and Bitcoin network/
  )
})
