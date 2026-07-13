import assert from "assert/strict"
import test from "node:test"

import {
  EthersP2TRCanonicalBridgeLifecycleLogVerifier,
  EthersP2TRSignatureFraudBridgeLifecycleEventSource as VerifiedEthersP2TRSignatureFraudBridgeLifecycleEventSource,
  P2TRBridgeLifecycleScanCursor,
  P2TRBridgeLifecycleScanCursorStore,
  P2TRCanonicalBridgeLifecycleEventLog,
  P2TRCanonicalBridgeLifecycleLogVerifier,
  EthersP2TRSignatureFraudBridgeLifecycleEventSourceOptions,
  P2TREthersBridgeLifecycleContract,
  P2TREthersBridgeLifecycleEventLog,
} from "../src/index.js"

const defeatedFilter = { event: "defeated" }
const timedOutFilter = { event: "timed-out" }
const movingFundsCompletedFilter = { event: "moving-funds-completed" }
const redemptionsCompletedFilter = { event: "redemptions-completed" }

type TestLifecycleSourceOptions = Omit<
  EthersP2TRSignatureFraudBridgeLifecycleEventSourceOptions,
  "canonicalLogVerifier" | "sourceTrustDomainID"
>

class EthersP2TRSignatureFraudBridgeLifecycleEventSource {
  private readonly source: VerifiedEthersP2TRSignatureFraudBridgeLifecycleEventSource

  constructor(
    p2trSignatureFraudRouter: P2TREthersBridgeLifecycleContract,
    bridgeOrOptions:
      | P2TREthersBridgeLifecycleContract
      | TestLifecycleSourceOptions = {},
    maybeOptions: TestLifecycleSourceOptions = {}
  ) {
    const hasSeparateBridge = isBridgeLifecycleContract(bridgeOrOptions)
    const bridge = hasSeparateBridge
      ? bridgeOrOptions
      : p2trSignatureFraudRouter
    const options = hasSeparateBridge ? maybeOptions : bridgeOrOptions
    const verifiedOptions = {
      ...options,
      sourceTrustDomainID: "indexer.test",
      canonicalLogVerifier: acceptingCanonicalVerifier(bridge),
    }

    this.source = hasSeparateBridge
      ? new VerifiedEthersP2TRSignatureFraudBridgeLifecycleEventSource(
          p2trSignatureFraudRouter,
          bridge,
          verifiedOptions
        )
      : new VerifiedEthersP2TRSignatureFraudBridgeLifecycleEventSource(
          p2trSignatureFraudRouter,
          verifiedOptions
        )
  }

  get p2trSignatureFraudWatchtowerStoreProfile() {
    return this.source.p2trSignatureFraudWatchtowerStoreProfile
  }

  get p2trSignatureFraudWatchtowerTransactionalStoreID() {
    return this.source.p2trSignatureFraudWatchtowerTransactionalStoreID
  }

  listBridgeLifecycleEvents() {
    return this.source.listBridgeLifecycleEvents()
  }

  commitBridgeLifecycleScan() {
    return this.source.commitBridgeLifecycleScan()
  }
}

const expectedLifecycleQueries = (
  fromBlock?: number | string,
  toBlock?: number | string
): {
  filter: unknown
  fromBlock?: number | string
  toBlock?: number | string
}[] => [
  { filter: defeatedFilter, fromBlock, toBlock },
  { filter: timedOutFilter, fromBlock, toBlock },
  { filter: movingFundsCompletedFilter, fromBlock, toBlock },
  { filter: redemptionsCompletedFilter, fromBlock, toBlock },
]

test("requires a canonical verifier from a different trust domain", () => {
  const contract = new FakeBridgeLifecycleContract({})

  assert.throws(
    () =>
      new VerifiedEthersP2TRSignatureFraudBridgeLifecycleEventSource(
        contract,
        undefined as never
      ),
    /requires independent canonical verification options/
  )
  assert.throws(
    () =>
      new VerifiedEthersP2TRSignatureFraudBridgeLifecycleEventSource(contract, {
        sourceTrustDomainID: "shared.example",
        canonicalLogVerifier: {
          ...acceptingCanonicalVerifier(contract),
          trustDomainID: "shared.example",
        },
      }),
    /must use different trust domains/
  )
})

test("rejects an unverified lifecycle log without advancing the cursor", async () => {
  const cursorStore = new FakeBridgeLifecycleScanCursorStore({
    lastScannedBlock: 49,
  })
  const contract = new FakeBridgeLifecycleContract(
    {
      defeated: [
        {
          args: { challengeKey: 1n },
          transactionHash: txHash("aa"),
          blockNumber: 60,
          logIndex: 0,
        },
      ],
    },
    100
  )
  const source = new VerifiedEthersP2TRSignatureFraudBridgeLifecycleEventSource(
    contract,
    {
      sourceTrustDomainID: "indexer.example",
      canonicalLogVerifier: {
        trustDomainID: "canonical.example",
        async getBlockNumber() {
          return 100
        },
        async getCanonicalBlockHash() {
          return txHash("88")
        },
        async verifyLifecycleLog() {
          return false
        },
      },
      confirmationDepth: 12,
      maxBlockRange: 100,
      scanCursorStore: cursorStore,
    }
  )

  await assert.rejects(
    source.listBridgeLifecycleEvents(),
    /log is not independently canonical/
  )
  await source.commitBridgeLifecycleScan()
  assert.equal(cursorStore.savedCursor, undefined)
})

test("bounds cursor progress by the independent canonical head", async () => {
  const cursorStore = new FakeBridgeLifecycleScanCursorStore({
    lastScannedBlock: 49,
  })
  const contract = new FakeBridgeLifecycleContract({}, 1_000)
  const source = new VerifiedEthersP2TRSignatureFraudBridgeLifecycleEventSource(
    contract,
    {
      sourceTrustDomainID: "indexer.example",
      canonicalLogVerifier: {
        trustDomainID: "canonical.example",
        async getBlockNumber() {
          return 100
        },
        async getCanonicalBlockHash() {
          return txHash("88")
        },
        async verifyLifecycleLog() {
          return true
        },
      },
      confirmationDepth: 12,
      maxBlockRange: 100,
      scanCursorStore: cursorStore,
    }
  )

  await source.listBridgeLifecycleEvents()
  assert.deepEqual(contract.queries, expectedLifecycleQueries(50, 88))
  await source.commitBridgeLifecycleScan()
  assert.deepEqual(cursorStore.savedCursor, { lastScannedBlock: 88 })
})

test("verifies exact receipt log membership through an independent provider", async () => {
  const emitter = `0x${"42".repeat(20)}`
  const canonicalLog: P2TRCanonicalBridgeLifecycleEventLog = {
    address: emitter,
    blockHash: txHash("88"),
    blockNumber: 60,
    data: "0x1234",
    logIndex: 2,
    removed: false,
    topics: [txHash("01"), txHash("02")],
    transactionHash: txHash("aa"),
  }
  let receiptLogs: P2TREthersBridgeLifecycleEventLog[] = [canonicalLog]
  const verifier = new EthersP2TRCanonicalBridgeLifecycleLogVerifier(
    "canonical.example",
    {
      async getBlockNumber() {
        return 100
      },
      async getBlock() {
        return { hash: canonicalLog.blockHash }
      },
      async getTransactionReceipt() {
        return {
          status: 1,
          blockHash: canonicalLog.blockHash,
          blockNumber: canonicalLog.blockNumber,
          transactionHash: canonicalLog.transactionHash,
          logs: receiptLogs,
        }
      },
    }
  )

  assert.equal(
    await verifier.verifyLifecycleLog({
      eventName: "P2TRSignatureFraudChallengeDefeated",
      expectedEmitter: emitter,
      log: canonicalLog,
    }),
    true
  )

  receiptLogs = [{ ...canonicalLog, data: "0xabcd" }]
  assert.equal(
    await verifier.verifyLifecycleLog({
      eventName: "P2TRSignatureFraudChallengeDefeated",
      expectedEmitter: emitter,
      log: canonicalLog,
    }),
    false
  )
})

test("maps Bridge defeat and timeout logs to watchtower lifecycle events", async () => {
  const contract = new FakeBridgeLifecycleContract({
    defeated: [
      {
        args: {
          walletID: walletID(),
          bridgeChallengeIdentity: bridgeChallengeIdentity(),
          challengeKey: fakeBigNumber(2n),
          sighash: sighash(),
        },
        transactionHash: txHash("aa"),
        blockNumber: 11,
        logIndex: 1,
      },
    ],
    timedOut: [
      {
        args: [
          walletID(),
          walletPubKeyHash(),
          bridgeChallengeIdentity(),
          1n,
          sighash(),
        ],
        transactionHash: txHash("bb"),
        blockNumber: 10,
        logIndex: 3,
      },
    ],
  })
  const source = new EthersP2TRSignatureFraudBridgeLifecycleEventSource(
    contract,
    { fromBlock: 100, toBlock: 120 }
  )

  const events = await source.listBridgeLifecycleEvents()

  assert.deepEqual(contract.queries, expectedLifecycleQueries(100, 120))
  assert.deepEqual(events, [
    {
      type: "slashed",
      bridgeChallengeKey: `0x${"0".repeat(63)}1`,
      slashingTxHash: txHash("bb"),
      walletID: walletID(),
      bridgeChallengeIdentity: bridgeChallengeIdentity(),
      sighash: sighash(),
    },
    {
      type: "rewarded",
      bridgeChallengeKey: `0x${"0".repeat(63)}1`,
      rewardTxHash: txHash("bb"),
      walletID: walletID(),
      bridgeChallengeIdentity: bridgeChallengeIdentity(),
      sighash: sighash(),
    },
    {
      type: "defeated",
      bridgeChallengeKey: `0x${"0".repeat(63)}2`,
      defeatTxHash: txHash("aa"),
      walletID: walletID(),
      bridgeChallengeIdentity: bridgeChallengeIdentity(),
      sighash: sighash(),
    },
  ])
})

test("maps Bridge completed spend proof logs to honest spend evidence events", async () => {
  const source = new EthersP2TRSignatureFraudBridgeLifecycleEventSource(
    new FakeBridgeLifecycleContract({
      movingFundsCompleted: [
        {
          args: { movingFundsTxHash: txHash("ab") },
          transactionHash: txHash("21"),
          blockNumber: 8,
          logIndex: 0,
        },
      ],
      redemptionsCompleted: [
        {
          args: [walletPubKeyHash(), txHash("cd")],
          transactionHash: txHash("22"),
          blockNumber: 9,
          logIndex: 0,
        },
      ],
    }),
    { fromBlock: 1, toBlock: 20 }
  )

  assert.deepEqual(await source.listBridgeLifecycleEvents(), [
    {
      type: "honest-spend-proven",
      bitcoinTxHash: txHash("ab"),
      spendType: "moving-funds",
    },
    {
      type: "honest-spend-proven",
      bitcoinTxHash: txHash("cd"),
      spendType: "redemption",
    },
  ])
})

test("queries P2TR router and Bridge lifecycle events from separate contracts", async () => {
  const router = new FakeBridgeLifecycleContract(
    {
      defeated: [
        {
          args: {
            challengeKey: 2n,
            walletID: walletID(),
            bridgeChallengeIdentity: bridgeChallengeIdentity(),
            sighash: sighash(),
          },
          transactionHash: txHash("aa"),
          blockNumber: 11,
          logIndex: 0,
        },
      ],
    },
    undefined,
    {},
    ["defeated", "timedOut"]
  )
  const bridge = new FakeBridgeLifecycleContract(
    {
      movingFundsCompleted: [
        {
          args: { movingFundsTxHash: txHash("ab") },
          transactionHash: txHash("21"),
          blockNumber: 12,
          logIndex: 0,
        },
      ],
    },
    undefined,
    {},
    ["movingFundsCompleted", "redemptionsCompleted"]
  )
  const source = new EthersP2TRSignatureFraudBridgeLifecycleEventSource(
    router,
    bridge,
    { fromBlock: 1, toBlock: 20 }
  )

  const events = await source.listBridgeLifecycleEvents()

  assert.deepEqual(router.queries, [
    { filter: defeatedFilter, fromBlock: 1, toBlock: 20 },
    { filter: timedOutFilter, fromBlock: 1, toBlock: 20 },
  ])
  assert.deepEqual(bridge.queries, [
    { filter: movingFundsCompletedFilter, fromBlock: 1, toBlock: 20 },
    { filter: redemptionsCompletedFilter, fromBlock: 1, toBlock: 20 },
  ])
  assert.deepEqual(
    events.map((event) => event.type),
    ["defeated", "honest-spend-proven"]
  )
})

test("orders Bridge lifecycle logs deterministically when positions match", async () => {
  const source = new EthersP2TRSignatureFraudBridgeLifecycleEventSource(
    new FakeBridgeLifecycleContract({
      defeated: [
        {
          args: { challengeKey: 3n },
          transactionHash: txHash("33"),
          blockNumber: 11,
          logIndex: 1,
        },
      ],
      timedOut: [
        {
          args: { challengeKey: 2n },
          transactionHash: txHash("22"),
          blockNumber: 11,
          logIndex: 1,
        },
      ],
    }),
    { fromBlock: 10, toBlock: 12 }
  )

  const events = await source.listBridgeLifecycleEvents()

  assert.deepEqual(
    events.map((event) => event.bridgeChallengeKey),
    [`0x${"0".repeat(63)}2`, `0x${"0".repeat(63)}2`, `0x${"0".repeat(63)}3`]
  )
})

test("can map Bridge timeout logs to a single status when configured", async () => {
  const source = new EthersP2TRSignatureFraudBridgeLifecycleEventSource(
    new FakeBridgeLifecycleContract({
      timedOut: [
        {
          args: { challengeKey: "0x03" },
          transactionHash: txHash("cc"),
        },
      ],
    }),
    { timedOutEventStatus: "rewarded" }
  )

  assert.deepEqual(await source.listBridgeLifecycleEvents(), [
    {
      type: "rewarded",
      bridgeChallengeKey: `0x${"0".repeat(63)}3`,
      rewardTxHash: txHash("cc"),
    },
  ])
})

test("derives a confirmed toBlock from provider head and confirmation depth", async () => {
  const contract = new FakeBridgeLifecycleContract(
    {
      defeated: [
        {
          args: { challengeKey: 4n },
          transactionHash: txHash("ee"),
        },
      ],
    },
    150
  )
  const source = new EthersP2TRSignatureFraudBridgeLifecycleEventSource(
    contract,
    { fromBlock: 100, confirmationDepth: 12, maxBlockRange: 40 }
  )

  await source.listBridgeLifecycleEvents()

  assert.deepEqual(contract.queries, expectedLifecycleQueries(100, 138))
})

test("skips Bridge lifecycle scans when no block is deep enough", async () => {
  const contract = new FakeBridgeLifecycleContract(
    {
      defeated: [
        {
          args: { challengeKey: 5n },
          transactionHash: txHash("ff"),
        },
      ],
    },
    5
  )
  const source = new EthersP2TRSignatureFraudBridgeLifecycleEventSource(
    contract,
    { fromBlock: 0, confirmationDepth: 12 }
  )

  assert.deepEqual(await source.listBridgeLifecycleEvents(), [])
  assert.deepEqual(contract.queries, [])
})

test("uses and commits a durable Bridge lifecycle scan cursor", async () => {
  const cursorStore = new FakeBridgeLifecycleScanCursorStore({
    lastScannedBlock: 120,
  })
  const contract = new FakeBridgeLifecycleContract(
    {
      defeated: [
        {
          args: { challengeKey: 6n },
          transactionHash: txHash("12"),
        },
      ],
    },
    150
  )
  const source = new EthersP2TRSignatureFraudBridgeLifecycleEventSource(
    contract,
    { confirmationDepth: 12, maxBlockRange: 40, scanCursorStore: cursorStore }
  )

  await source.listBridgeLifecycleEvents()

  assert.deepEqual(contract.queries, expectedLifecycleQueries(121, 138))
  assert.equal(cursorStore.savedCursor, undefined)

  await source.commitBridgeLifecycleScan()

  assert.deepEqual(cursorStore.savedCursor, { lastScannedBlock: 138 })
})

test("advances cursor-backed Bridge lifecycle scans one bounded window at a time", async () => {
  const cursorStore = new FakeBridgeLifecycleScanCursorStore({
    lastScannedBlock: 120,
  })
  const contract = new FakeBridgeLifecycleContract(
    {
      defeated: [
        {
          args: { challengeKey: 7n },
          transactionHash: txHash("13"),
        },
      ],
    },
    500
  )
  const source = new EthersP2TRSignatureFraudBridgeLifecycleEventSource(
    contract,
    { confirmationDepth: 12, maxBlockRange: 40, scanCursorStore: cursorStore }
  )

  await source.listBridgeLifecycleEvents()

  assert.deepEqual(contract.queries, expectedLifecycleQueries(121, 160))

  await source.commitBridgeLifecycleScan()

  assert.deepEqual(cursorStore.savedCursor, { lastScannedBlock: 160 })
})

test("clears pending Bridge lifecycle scan cursors before empty scans", async () => {
  const cursorStore = new FakeBridgeLifecycleScanCursorStore({
    lastScannedBlock: 120,
  })
  const contract = new FakeBridgeLifecycleContract(
    {
      defeated: [
        {
          args: { challengeKey: 7n },
          transactionHash: txHash("13"),
        },
      ],
    },
    150
  )
  const source = new EthersP2TRSignatureFraudBridgeLifecycleEventSource(
    contract,
    { confirmationDepth: 12, maxBlockRange: 40, scanCursorStore: cursorStore }
  )

  await source.listBridgeLifecycleEvents()
  contract.latestBlock = 5

  assert.deepEqual(await source.listBridgeLifecycleEvents(), [])

  await source.commitBridgeLifecycleScan()

  assert.equal(cursorStore.savedCursor, undefined)
})

test("applies a Bridge lifecycle cursor overlap for reorg replay", async () => {
  const cursorStore = new FakeBridgeLifecycleScanCursorStore({
    lastScannedBlock: 120,
  })
  const contract = new FakeBridgeLifecycleContract(
    {
      defeated: [
        {
          args: { challengeKey: 8n },
          transactionHash: txHash("13"),
        },
      ],
    },
    150
  )
  const source = new EthersP2TRSignatureFraudBridgeLifecycleEventSource(
    contract,
    {
      confirmationDepth: 12,
      maxBlockRange: 40,
      cursorOverlapBlocks: 6,
      scanCursorStore: cursorStore,
    }
  )

  await source.listBridgeLifecycleEvents()

  assert.deepEqual(contract.queries, expectedLifecycleQueries(115, 138))

  await source.commitBridgeLifecycleScan()

  assert.deepEqual(cursorStore.savedCursor, { lastScannedBlock: 138 })
})

test("validates and commits Bridge lifecycle cursor block hashes when required", async () => {
  const cursorStore = new FakeBridgeLifecycleScanCursorStore({
    lastScannedBlock: 120,
    lastScannedBlockHash: txHash("aa"),
  })
  const contract = new FakeBridgeLifecycleContract(
    {
      defeated: [
        {
          args: { challengeKey: 9n },
          transactionHash: txHash("14"),
        },
      ],
    },
    150,
    {
      120: txHash("aa"),
      138: txHash("bb"),
    }
  )
  const source = new EthersP2TRSignatureFraudBridgeLifecycleEventSource(
    contract,
    {
      confirmationDepth: 12,
      maxBlockRange: 40,
      requireCursorBlockHash: true,
      scanCursorStore: cursorStore,
    }
  )

  await source.listBridgeLifecycleEvents()

  assert.deepEqual(contract.queries, expectedLifecycleQueries(121, 138))

  await source.commitBridgeLifecycleScan()

  assert.deepEqual(cursorStore.savedCursor, {
    lastScannedBlock: 138,
    lastScannedBlockHash: txHash("bb"),
  })
})

test("rejects Bridge lifecycle cursor commits when the scan boundary hash changes", async () => {
  const cursorStore = new FakeBridgeLifecycleScanCursorStore({
    lastScannedBlock: 120,
    lastScannedBlockHash: txHash("aa"),
  })
  const contract = new FakeBridgeLifecycleContract(
    {
      defeated: [
        {
          args: { challengeKey: 9n },
          transactionHash: txHash("14"),
        },
      ],
    },
    150,
    {
      120: txHash("aa"),
      138: txHash("bb"),
    }
  )
  const source = new EthersP2TRSignatureFraudBridgeLifecycleEventSource(
    contract,
    {
      confirmationDepth: 12,
      maxBlockRange: 40,
      requireCursorBlockHash: true,
      scanCursorStore: cursorStore,
    }
  )

  await source.listBridgeLifecycleEvents()
  contract.setBlockHash(138, txHash("cc"))

  await assert.rejects(
    source.commitBridgeLifecycleScan(),
    /cursor commit block hash changed after scan/
  )
  assert.equal(cursorStore.savedCursor, undefined)
})

test("rejects stale Bridge lifecycle cursor block hashes before querying logs", async () => {
  const cursorStore = new FakeBridgeLifecycleScanCursorStore({
    lastScannedBlock: 120,
    lastScannedBlockHash: txHash("aa"),
  })
  const contract = new FakeBridgeLifecycleContract({}, 150, {
    120: txHash("bb"),
  })
  const source = new EthersP2TRSignatureFraudBridgeLifecycleEventSource(
    contract,
    {
      confirmationDepth: 12,
      maxBlockRange: 40,
      requireCursorBlockHash: true,
      scanCursorStore: cursorStore,
    }
  )

  await assert.rejects(
    source.listBridgeLifecycleEvents(),
    /scan cursor block hash mismatch/
  )
  assert.deepEqual(contract.queries, [])
})

test("rejects unsafe Bridge lifecycle block range options", async () => {
  assert.throws(
    () =>
      new EthersP2TRSignatureFraudBridgeLifecycleEventSource(
        new FakeBridgeLifecycleContract({}),
        { fromBlock: -1 }
      ),
    /fromBlock must be a non-negative integer/
  )
  assert.throws(
    () =>
      new EthersP2TRSignatureFraudBridgeLifecycleEventSource(
        new FakeBridgeLifecycleContract({}),
        { toBlock: 1.5 }
      ),
    /toBlock must be a non-negative integer/
  )
  assert.throws(
    () =>
      new EthersP2TRSignatureFraudBridgeLifecycleEventSource(
        new FakeBridgeLifecycleContract({}),
        { confirmationDepth: -1 }
      ),
    /confirmation depth must be non-negative/
  )
  assert.throws(
    () =>
      new EthersP2TRSignatureFraudBridgeLifecycleEventSource(
        new FakeBridgeLifecycleContract({}),
        { maxBlockRange: 0 }
      ),
    /max block range must be positive/
  )
  assert.throws(
    () =>
      new EthersP2TRSignatureFraudBridgeLifecycleEventSource(
        new FakeBridgeLifecycleContract({}),
        { cursorOverlapBlocks: -1 }
      ),
    /cursor overlap blocks must be non-negative/
  )
  assert.throws(
    () =>
      new EthersP2TRSignatureFraudBridgeLifecycleEventSource(
        new FakeBridgeLifecycleContract({}),
        { timedOutEventStatus: "timeout" as never }
      ),
    /timed-out event status must be slashed or rewarded/
  )
  assert.throws(
    () =>
      new EthersP2TRSignatureFraudBridgeLifecycleEventSource(
        new FakeBridgeLifecycleContract({}),
        {
          fromBlock: 1,
          confirmationDepth: 1,
          maxBlockRange: 10,
          scanCursorStore: new FakeBridgeLifecycleScanCursorStore(),
        }
      ),
    /scan cursor cannot be combined with fromBlock/
  )
  assert.throws(
    () =>
      new EthersP2TRSignatureFraudBridgeLifecycleEventSource(
        new FakeBridgeLifecycleContract({}),
        {
          confirmationDepth: 1,
          scanCursorStore: new FakeBridgeLifecycleScanCursorStore(),
        }
      ),
    /scan cursor requires maxBlockRange/
  )
  assert.throws(
    () =>
      new EthersP2TRSignatureFraudBridgeLifecycleEventSource(
        new FakeBridgeLifecycleContract({}),
        {
          confirmationDepth: 1,
          maxBlockRange: 10,
          cursorOverlapBlocks: 10,
          scanCursorStore: new FakeBridgeLifecycleScanCursorStore(),
        }
      ),
    /cursor overlap blocks must be less than maxBlockRange/
  )
  assert.throws(
    () =>
      new EthersP2TRSignatureFraudBridgeLifecycleEventSource(
        new FakeBridgeLifecycleContract({}),
        {
          maxBlockRange: 10,
          scanCursorStore: new FakeBridgeLifecycleScanCursorStore(),
        }
      ),
    /scan cursor requires a numeric toBlock or confirmation depth/
  )
  assert.throws(
    () =>
      new EthersP2TRSignatureFraudBridgeLifecycleEventSource(
        new FakeBridgeLifecycleContract({}),
        {
          toBlock: "latest",
          maxBlockRange: 10,
          scanCursorStore: new FakeBridgeLifecycleScanCursorStore(),
        }
      ),
    /scan cursor requires a numeric toBlock or confirmation depth/
  )
  assert.throws(
    () =>
      new EthersP2TRSignatureFraudBridgeLifecycleEventSource(
        new FakeBridgeLifecycleContract({}),
        {
          requireCursorBlockHash: true,
        }
      ),
    /cursor block-hash validation requires a scan cursor/
  )

  const source = new EthersP2TRSignatureFraudBridgeLifecycleEventSource(
    new FakeBridgeLifecycleContract({}),
    { fromBlock: 100, toBlock: 200, maxBlockRange: 50 }
  )

  await assert.rejects(
    source.listBridgeLifecycleEvents(),
    /block range exceeds maxBlockRange/
  )

  await assert.rejects(
    new EthersP2TRSignatureFraudBridgeLifecycleEventSource(
      new FakeBridgeLifecycleContract({}, 10),
      {
        confirmationDepth: 1,
        maxBlockRange: 10,
        scanCursorStore: new FakeBridgeLifecycleScanCursorStore({
          lastScannedBlock: -1,
        }),
      }
    ).listBridgeLifecycleEvents(),
    /scan cursor must be non-negative/
  )

  await assert.rejects(
    new EthersP2TRSignatureFraudBridgeLifecycleEventSource(
      new FakeBridgeLifecycleContract({}, 10),
      {
        confirmationDepth: 1,
        maxBlockRange: 10,
        requireCursorBlockHash: true,
        scanCursorStore: new FakeBridgeLifecycleScanCursorStore({
          lastScannedBlock: 1,
        }),
      }
    ).listBridgeLifecycleEvents(),
    /scan cursor block hash is required/
  )
})

test("rejects malformed Bridge lifecycle logs before mutating watchtower state", async () => {
  const source = new EthersP2TRSignatureFraudBridgeLifecycleEventSource(
    new FakeBridgeLifecycleContract({
      defeated: [
        {
          args: { walletID: walletID() },
          transactionHash: txHash("dd"),
        },
      ],
    })
  )

  await assert.rejects(
    source.listBridgeLifecycleEvents(),
    /missing challengeKey/
  )

  await assert.rejects(
    new EthersP2TRSignatureFraudBridgeLifecycleEventSource(
      new FakeBridgeLifecycleContract({
        defeated: [
          {
            args: { challengeKey: 1n },
            transactionHash: txHash("de"),
            blockNumber: -1,
          },
        ],
      })
    ).listBridgeLifecycleEvents(),
    /event block number must be a non-negative integer/
  )

  await assert.rejects(
    new EthersP2TRSignatureFraudBridgeLifecycleEventSource(
      new FakeBridgeLifecycleContract({
        defeated: [
          {
            args: { challengeKey: 1n },
            transactionHash: txHash("df"),
            blockNumber: 10,
            logIndex: 1.5,
          },
        ],
      })
    ).listBridgeLifecycleEvents(),
    /event log index must be a non-negative integer/
  )

  await assert.rejects(
    new EthersP2TRSignatureFraudBridgeLifecycleEventSource(
      new FakeBridgeLifecycleContract({
        defeated: [
          {
            args: {
              walletID: "0x1234",
              challengeKey: 1n,
            },
            transactionHash: txHash("ef"),
          },
        ],
      })
    ).listBridgeLifecycleEvents(),
    /event wallet ID must be 32 bytes/
  )

  await assert.rejects(
    new EthersP2TRSignatureFraudBridgeLifecycleEventSource(
      new FakeBridgeLifecycleContract({
        movingFundsCompleted: [
          {
            args: {},
            transactionHash: txHash("f0"),
          },
        ],
      })
    ).listBridgeLifecycleEvents(),
    /missing moving-funds transaction hash/
  )

  await assert.rejects(
    new EthersP2TRSignatureFraudBridgeLifecycleEventSource(
      new FakeBridgeLifecycleContract({
        redemptionsCompleted: [
          {
            args: [walletPubKeyHash(), "0x1234"],
            transactionHash: txHash("f1"),
          },
        ],
      })
    ).listBridgeLifecycleEvents(),
    /redemption transaction hash.*32 bytes/
  )
})

test("rejects contracts without the required Bridge event filters", async () => {
  const source = new EthersP2TRSignatureFraudBridgeLifecycleEventSource({
    filters: {},
    async queryFilter() {
      return []
    },
  })

  await assert.rejects(
    source.listBridgeLifecycleEvents(),
    /filter P2TRSignatureFraudChallengeDefeated is unavailable/
  )
})

type FakeBridgeLifecycleFilter =
  | "defeated"
  | "timedOut"
  | "movingFundsCompleted"
  | "redemptionsCompleted"

const allFakeBridgeLifecycleFilters: FakeBridgeLifecycleFilter[] = [
  "defeated",
  "timedOut",
  "movingFundsCompleted",
  "redemptionsCompleted",
]

class FakeBridgeLifecycleContract implements P2TREthersBridgeLifecycleContract {
  readonly address = `0x${"42".repeat(20)}`
  readonly provider?: {
    getBlockNumber(): Promise<number>
    getBlock(blockNumber: number): Promise<{ hash: string } | undefined>
  }

  readonly filters: Record<string, () => unknown>

  readonly queries: {
    filter: unknown
    fromBlock?: number | string
    toBlock?: number | string
  }[] = []

  constructor(
    private readonly logs: {
      defeated?: P2TREthersBridgeLifecycleEventLog[]
      timedOut?: P2TREthersBridgeLifecycleEventLog[]
      movingFundsCompleted?: P2TREthersBridgeLifecycleEventLog[]
      redemptionsCompleted?: P2TREthersBridgeLifecycleEventLog[]
    },
    public latestBlock?: number,
    private readonly blockHashes: Record<number, string | undefined> = {},
    availableFilters: FakeBridgeLifecycleFilter[] = allFakeBridgeLifecycleFilters
  ) {
    this.filters = buildFakeBridgeLifecycleFilters(availableFilters)

    const hasProvider =
      latestBlock !== undefined || Object.keys(blockHashes).length > 0
    this.provider = hasProvider
      ? {
          getBlockNumber: async () => {
            return this.latestBlock ?? 0
          },
          getBlock: async (blockNumber: number) => {
            const hash = this.blockHashes[blockNumber]

            return hash === undefined ? undefined : { hash }
          },
        }
      : undefined
  }

  async queryFilter(
    filter: unknown,
    fromBlock?: number | string,
    toBlock?: number | string
  ): Promise<P2TREthersBridgeLifecycleEventLog[]> {
    this.queries.push({ filter, fromBlock, toBlock })

    if (filter === defeatedFilter) {
      return (this.logs.defeated ?? []).map((log) =>
        canonicalLogFixture(log, this.address)
      )
    }

    if (filter === timedOutFilter) {
      return (this.logs.timedOut ?? []).map((log) =>
        canonicalLogFixture(log, this.address)
      )
    }

    if (filter === movingFundsCompletedFilter) {
      return (this.logs.movingFundsCompleted ?? []).map((log) =>
        canonicalLogFixture(log, this.address)
      )
    }

    if (filter === redemptionsCompletedFilter) {
      return (this.logs.redemptionsCompleted ?? []).map((log) =>
        canonicalLogFixture(log, this.address)
      )
    }

    throw new Error("unknown filter")
  }

  setBlockHash(blockNumber: number, blockHash: string): void {
    this.blockHashes[blockNumber] = blockHash
  }
}

function isBridgeLifecycleContract(
  value: P2TREthersBridgeLifecycleContract | TestLifecycleSourceOptions
): value is P2TREthersBridgeLifecycleContract {
  return (
    typeof (value as P2TREthersBridgeLifecycleContract).queryFilter ===
    "function"
  )
}

function acceptingCanonicalVerifier(
  contract: P2TREthersBridgeLifecycleContract
): P2TRCanonicalBridgeLifecycleLogVerifier {
  return {
    trustDomainID: "canonical.test",
    async getBlockNumber() {
      return contract.provider === undefined
        ? Number.MAX_SAFE_INTEGER
        : contract.provider.getBlockNumber()
    },
    async getCanonicalBlockHash(blockNumber) {
      const block = await contract.provider?.getBlock?.(blockNumber)
      return block?.hash ?? txHash("99")
    },
    async verifyLifecycleLog() {
      return true
    },
  }
}

function canonicalLogFixture(
  log: P2TREthersBridgeLifecycleEventLog,
  address: string
): P2TREthersBridgeLifecycleEventLog {
  return {
    address,
    blockHash: txHash("99"),
    blockNumber: 0,
    data: "0x",
    logIndex: 0,
    removed: false,
    topics: [txHash("01")],
    ...log,
  }
}

function buildFakeBridgeLifecycleFilters(
  availableFilters: FakeBridgeLifecycleFilter[]
): Record<string, () => unknown> {
  const filters: Record<string, () => unknown> = {}

  if (availableFilters.includes("defeated")) {
    filters.P2TRSignatureFraudChallengeDefeated = () => defeatedFilter
  }

  if (availableFilters.includes("timedOut")) {
    filters.P2TRSignatureFraudChallengeDefeatTimedOut = () => timedOutFilter
  }

  if (availableFilters.includes("movingFundsCompleted")) {
    filters.MovingFundsCompleted = () => movingFundsCompletedFilter
  }

  if (availableFilters.includes("redemptionsCompleted")) {
    filters.RedemptionsCompleted = () => redemptionsCompletedFilter
  }

  return filters
}

class FakeBridgeLifecycleScanCursorStore
  implements P2TRBridgeLifecycleScanCursorStore
{
  savedCursor?: P2TRBridgeLifecycleScanCursor

  constructor(private readonly cursor?: P2TRBridgeLifecycleScanCursor) {}

  async loadBridgeLifecycleScanCursor(): Promise<
    P2TRBridgeLifecycleScanCursor | undefined
  > {
    return this.cursor
  }

  async saveBridgeLifecycleScanCursor(
    cursor: P2TRBridgeLifecycleScanCursor
  ): Promise<void> {
    this.savedCursor = cursor
  }
}

function fakeBigNumber(value: bigint): { toHexString(): string } {
  return {
    toHexString: () => `0x${value.toString(16)}`,
  }
}

function walletID(): string {
  return `0x${"11".repeat(32)}`
}

function walletPubKeyHash(): string {
  return `0x${"22".repeat(20)}`
}

function bridgeChallengeIdentity(): string {
  return `0x${"33".repeat(32)}`
}

function sighash(): string {
  return `0x${"44".repeat(32)}`
}

function txHash(byte: string): string {
  return `0x${byte.repeat(32)}`
}
