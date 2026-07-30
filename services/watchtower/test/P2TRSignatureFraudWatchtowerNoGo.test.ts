import assert from "assert/strict"
import test from "node:test"

import type {
  BitcoinClient,
  P2TRSignatureFraudChallengeSubmitter,
} from "@keep-network/tbtc-v2.ts"

import {
  P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV,
  P2TRSignatureFraudWatchtowerService,
  createFileBackedP2TRSignatureFraudWatchtowerRuntime,
  loadP2TRSignatureFraudWatchtowerRuntimeConfig,
} from "../src/index.js"

class CountingSubmitter implements P2TRSignatureFraudChallengeSubmitter {
  calls = 0

  async submitSignatureFraudChallenge(): Promise<string> {
    this.calls++
    return `0x${"11".repeat(32)}`
  }
}

const walletID = `0x${"22".repeat(32)}`

const serviceDependencies = (submitter: CountingSubmitter) =>
  ({
    bitcoinClient: {} as BitcoinClient,
    challengeSubmitter: submitter,
    transactionSource: {
      async listMempoolTransactions() {
        return []
      },
      async listConfirmedTransactions() {
        return { transactions: [], complete: true }
      },
    },
    bridgeLifecycleEventSource: {
      async listBridgeLifecycleEvents() {
        return []
      },
    },
    persistence: {
      async loadChallengeRecords() {
        return []
      },
      async saveChallengeRecords() {},
    },
  } as any)

test("service constructor rejects submit mode before invoking its submitter", () => {
  const submitter = new CountingSubmitter()

  assert.throws(
    () =>
      new P2TRSignatureFraudWatchtowerService(
        { registeredWalletIDs: [walletID], submitChallenges: true },
        serviceDependencies(submitter)
      ),
    /bounded\/no-go/
  )
  assert.equal(submitter.calls, 0)
})

test("service permits zero-wallet observation startup before canonical registration", async () => {
  const submitter = new CountingSubmitter()
  const service = new P2TRSignatureFraudWatchtowerService(
    { registeredWalletIDs: [], submitChallenges: false },
    serviceDependencies(submitter)
  )

  const report = await service.processCycle()

  assert.equal(report.metrics.totalRecords, 0)
  assert.equal(submitter.calls, 0)
})

test("file-backed runtime rejects programmatic submit mode before invoking its submitter", () => {
  const submitter = new CountingSubmitter()
  const dependencies = serviceDependencies(submitter)
  delete dependencies.persistence

  assert.throws(
    () =>
      createFileBackedP2TRSignatureFraudWatchtowerRuntime(
        {
          stateFilePath: "/tmp/p2tr-watchtower-no-go-state.json",
          bridgeLifecycle: {},
          transactionSource: {},
          service: { registeredWalletIDs: [walletID], submitChallenges: true },
          loop: { continueOnError: false, pollIntervalMs: 1_000 },
        } as any,
        dependencies
      ),
    /bounded\/no-go/
  )
  assert.equal(submitter.calls, 0)
})

test("environment submit mode is rejected before runtime construction", () => {
  const submitter = new CountingSubmitter()

  assert.throws(
    () =>
      loadP2TRSignatureFraudWatchtowerRuntimeConfig({
        [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.stateFilePath]:
          "/tmp/p2tr-watchtower-no-go-state.json",
        [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.walletIDs]: walletID,
        [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.submitChallenges]: "true",
      }),
    /bounded\/no-go/
  )
  assert.equal(submitter.calls, 0)
})
