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
  P2TREthersCanonicalBridgeLifecycleProvider,
  P2TREthersBridgeLifecycleContract,
  P2TREthersBridgeLifecycleEventLog,
  P2TREthersBridgeLifecycleProvider,
} from "../src/index.js"

const defeatedFilter = { event: "defeated" }
const timedOutFilter = { event: "timed-out" }
const movingFundsCompletedFilter = { event: "moving-funds-completed" }
const redemptionsCompletedFilter = { event: "redemptions-completed" }
const challengeSubmittedEventTopic =
  "0xdbf5fc7022aea04bb2f6b24831d36f88767a274b662858025f1e490c127ff876"
const challengeDefeatedEventTopic =
  "0x1c09e160fcfdba6315144c05e93357f8a6f0db7517253b7ce4854c3b6d3bafac"
const challengeDefeatTimedOutEventTopic =
  "0x798f765e06fb1f2a5b39a4ffddc27396be8ba8e51b59b1d08d82c95922e5b331"
const movingFundsCompletedEventTopic =
  "0xc635af1892551655b9dbb3256a0eed3e35baf4fcc5392b80e6a907b6f44a2838"
const redemptionsCompletedEventTopic =
  "0xa45596c10f758d32ec8cca64a0fbfe776052b08fdb3f026e0a87f52118bf8fbe"

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
      sourceTrustDomainID: "query-indexer.test",
      canonicalLogVerifier: acceptingCanonicalVerifier(
        p2trSignatureFraudRouter,
        bridge
      ),
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
  const canonicalLogVerifier = acceptingCanonicalVerifier(contract)

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
          trustDomainID: "shared.example",
          providerIdentity: canonicalLogVerifier.providerIdentity,
          getBlockNumber: () => canonicalLogVerifier.getBlockNumber(),
          getCanonicalBlockHash: (blockNumber) =>
            canonicalLogVerifier.getCanonicalBlockHash(blockNumber),
          verifyLifecycleLogRange: (verification) =>
            canonicalLogVerifier.verifyLifecycleLogRange(verification),
          verifyLifecycleLog: (verification) =>
            canonicalLogVerifier.verifyLifecycleLog(verification),
        },
      }),
    /must use different trust domains/
  )
})

test("rejects a canonical verifier backed by the single source provider", () => {
  const contract = new FakeBridgeLifecycleContract({})
  const canonicalLogVerifier = acceptingCanonicalVerifier(contract)

  assert.throws(
    () =>
      new VerifiedEthersP2TRSignatureFraudBridgeLifecycleEventSource(contract, {
        sourceTrustDomainID: "query-indexer.example",
        canonicalLogVerifier: verifierWithProviderIdentity(
          canonicalLogVerifier,
          contract.provider
        ),
      }),
    /must use different provider instances/
  )
})

test("rejects separate router and Bridge source provider instances", () => {
  const router = new FakeBridgeLifecycleContract({}, undefined, {}, [
    "defeated",
    "timedOut",
  ])
  const bridge = new FakeBridgeLifecycleContract({}, undefined, {}, [
    "movingFundsCompleted",
    "redemptionsCompleted",
  ])
  const canonicalLogVerifier = acceptingCanonicalVerifier(router, bridge)

  assert.throws(
    () =>
      new VerifiedEthersP2TRSignatureFraudBridgeLifecycleEventSource(
        router,
        bridge,
        {
          sourceTrustDomainID: "query-indexer.example",
          canonicalLogVerifier,
        }
      ),
    /must use the same source provider instance/
  )
})

test("rejects a canonical verifier backed by the shared separate-contract provider", () => {
  const sourceProvider = fakeBridgeLifecycleProvider()
  const router = new FakeBridgeLifecycleContract(
    {},
    undefined,
    {},
    ["defeated", "timedOut"],
    sourceProvider
  )
  const bridge = new FakeBridgeLifecycleContract(
    {},
    undefined,
    {},
    ["movingFundsCompleted", "redemptionsCompleted"],
    sourceProvider
  )
  const canonicalLogVerifier = acceptingCanonicalVerifier(router, bridge)

  assert.throws(
    () =>
      new VerifiedEthersP2TRSignatureFraudBridgeLifecycleEventSource(
        router,
        bridge,
        {
          sourceTrustDomainID: "query-indexer.example",
          canonicalLogVerifier: verifierWithProviderIdentity(
            canonicalLogVerifier,
            sourceProvider
          ),
        }
      ),
    /must use different provider instances/
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
        providerIdentity: {},
        async getBlockNumber() {
          return 100
        },
        async getCanonicalBlockHash() {
          return txHash("88")
        },
        async verifyLifecycleLogRange() {
          return true
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

test("rejects lifecycle-log omissions without advancing the cursor", async () => {
  const cursorStore = new FakeBridgeLifecycleScanCursorStore({
    lastScannedBlock: 49,
  })
  const contract = new FakeBridgeLifecycleContract({}, 100)
  const omittedCanonicalLog = canonicalLogFixture(
    {
      args: { challengeKey: 1n },
      transactionHash: txHash("ab"),
      blockNumber: 60,
      logIndex: 0,
    },
    contract.address,
    "defeated"
  )
  const canonicalProvider = new FakeIndependentCanonicalBridgeLifecycleProvider(
    [contract],
    [omittedCanonicalLog]
  )
  assert.notEqual(canonicalProvider, contract.provider)
  const source = new VerifiedEthersP2TRSignatureFraudBridgeLifecycleEventSource(
    contract,
    {
      sourceTrustDomainID: "query-indexer.example",
      canonicalLogVerifier: new EthersP2TRCanonicalBridgeLifecycleLogVerifier(
        "canonical-rpc.example",
        canonicalProvider
      ),
      confirmationDepth: 12,
      maxBlockRange: 100,
      scanCursorStore: cursorStore,
    }
  )

  await assert.rejects(
    source.listBridgeLifecycleEvents(),
    /P2TRSignatureFraudChallengeDefeated log range is not independently complete/
  )
  await source.commitBridgeLifecycleScan()
  assert.equal(cursorStore.savedCursor, undefined)
})

test("bounds canonical lifecycle verification across every event type without changing chain order", async () => {
  const completionOrder = [
    txHash("f5"),
    txHash("e4"),
    txHash("d3"),
    txHash("c2"),
    txHash("01"),
  ]
  const verifier = new DeferredCanonicalLogVerifier()
  const contract = new FakeBridgeLifecycleContract({
    defeated: [
      {
        args: { challengeKey: 5n },
        transactionHash: txHash("f5"),
        blockNumber: 14,
        logIndex: 0,
      },
      {
        args: { challengeKey: 1n },
        transactionHash: txHash("01"),
        blockNumber: 10,
        logIndex: 0,
      },
    ],
    timedOut: [
      {
        args: { challengeKey: 4n },
        transactionHash: txHash("e4"),
        blockNumber: 13,
        logIndex: 0,
      },
    ],
    movingFundsCompleted: [
      {
        args: { movingFundsTxHash: txHash("a1") },
        transactionHash: txHash("d3"),
        blockNumber: 12,
        logIndex: 0,
      },
    ],
    redemptionsCompleted: [
      {
        args: { redemptionTxHash: txHash("b1") },
        transactionHash: txHash("c2"),
        blockNumber: 11,
        logIndex: 0,
      },
    ],
  })
  const source = new VerifiedEthersP2TRSignatureFraudBridgeLifecycleEventSource(
    contract,
    {
      sourceTrustDomainID: "indexer.example",
      canonicalLogVerifier: verifier,
      canonicalLogVerificationConcurrency: 2,
      fromBlock: 1,
      toBlock: 20,
      timedOutEventStatus: "slashed",
    }
  )

  const eventsPromise = source.listBridgeLifecycleEvents()
  for (const transactionHash of completionOrder) {
    await verifier.release(transactionHash)
  }
  const events = await eventsPromise

  assert.equal(verifier.maxActive, 2)
  assert.equal(verifier.active, 0)
  assert.deepEqual(verifier.completedTransactionHashes, completionOrder)
  assert.deepEqual(
    [...verifier.startedTransactionHashes].sort(),
    [...completionOrder].sort()
  )
  assert.equal(new Set(verifier.startedTransactionHashes).size, 5)
  assert.deepEqual(
    events.map((event) =>
      event.type === "honest-spend-proven" ? event.spendType : event.type
    ),
    ["defeated", "redemption", "moving-funds", "slashed", "defeated"]
  )
})

test("bounds canonical lifecycle verification to eight calls by default", async () => {
  const transactionHashes = Array.from({ length: 9 }, (_, index) =>
    txHash((index + 1).toString(16).padStart(2, "0"))
  )
  const verifier = new DeferredCanonicalLogVerifier()
  const contract = new FakeBridgeLifecycleContract({
    defeated: transactionHashes.map((transactionHash, index) => ({
      args: { challengeKey: BigInt(index + 1) },
      transactionHash,
      blockNumber: index + 1,
      logIndex: 0,
    })),
  })
  const source = new VerifiedEthersP2TRSignatureFraudBridgeLifecycleEventSource(
    contract,
    {
      sourceTrustDomainID: "indexer.example",
      canonicalLogVerifier: verifier,
      fromBlock: 1,
      toBlock: 20,
    }
  )

  const eventsPromise = source.listBridgeLifecycleEvents()
  for (const transactionHash of transactionHashes) {
    await verifier.release(transactionHash)
  }
  const events = await eventsPromise

  assert.equal(verifier.maxActive, 8)
  assert.equal(verifier.active, 0)
  assert.deepEqual(
    [...verifier.startedTransactionHashes].sort(),
    [...transactionHashes].sort()
  )
  assert.equal(new Set(verifier.startedTransactionHashes).size, 9)
  assert.deepEqual(
    events.map((event) => event.bridgeChallengeKey),
    Array.from(
      { length: 9 },
      (_, index) => `0x${(index + 1).toString(16).padStart(64, "0")}`
    )
  )
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
        providerIdentity: {},
        async getBlockNumber() {
          return 100
        },
        async getCanonicalBlockHash() {
          return txHash("88")
        },
        async verifyLifecycleLogRange() {
          return true
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

test("rejects independently canonical logs above the resolved confirmation bound", async () => {
  const contract = new FakeBridgeLifecycleContract(
    {
      defeated: [
        {
          args: { challengeKey: 1n },
          transactionHash: txHash("aa"),
          blockNumber: 95,
        },
      ],
    },
    100
  )
  const source = new EthersP2TRSignatureFraudBridgeLifecycleEventSource(
    contract,
    { confirmationDepth: 12 }
  )

  await assert.rejects(
    source.listBridgeLifecycleEvents(),
    /outside the resolved block range/
  )
  assert.deepEqual(contract.queries, expectedLifecycleQueries(undefined, 88))
})

test("rejects independently canonical logs below a numeric lower bound", async () => {
  const contract = new FakeBridgeLifecycleContract({
    defeated: [
      {
        args: { challengeKey: 1n },
        transactionHash: txHash("aa"),
        blockNumber: 49,
      },
    ],
  })
  const source = new EthersP2TRSignatureFraudBridgeLifecycleEventSource(
    contract,
    { fromBlock: 50, toBlock: 88 }
  )

  await assert.rejects(
    source.listBridgeLifecycleEvents(),
    /outside the resolved block range/
  )
  assert.deepEqual(contract.queries, expectedLifecycleQueries(50, 88))
})

test("accepts independently canonical logs on inclusive numeric range boundaries", async () => {
  const contract = new FakeBridgeLifecycleContract({
    defeated: [
      {
        args: { challengeKey: 1n },
        transactionHash: txHash("aa"),
        blockNumber: 50,
      },
      {
        args: { challengeKey: 2n },
        transactionHash: txHash("bb"),
        blockNumber: 88,
      },
    ],
  })
  const source = new EthersP2TRSignatureFraudBridgeLifecycleEventSource(
    contract,
    { fromBlock: 50, toBlock: 88 }
  )

  const events = await source.listBridgeLifecycleEvents()

  assert.deepEqual(
    events.map((event) => event.type),
    ["defeated", "defeated"]
  )
  assert.deepEqual(contract.queries, expectedLifecycleQueries(50, 88))
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
    topics: [challengeDefeatedEventTopic, txHash("02")],
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
      async getLogs(filter) {
        return filterCanonicalProviderLogs(receiptLogs, filter)
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

test("accepts each supported canonical lifecycle event signature", async () => {
  const emitter = `0x${"42".repeat(20)}`
  const eventSignatures = [
    ["P2TRSignatureFraudChallengeDefeated", challengeDefeatedEventTopic],
    [
      "P2TRSignatureFraudChallengeDefeatTimedOut",
      challengeDefeatTimedOutEventTopic,
    ],
    ["MovingFundsCompleted", movingFundsCompletedEventTopic],
    ["RedemptionsCompleted", redemptionsCompletedEventTopic],
  ] as const

  for (const [eventName, eventTopic] of eventSignatures) {
    const canonicalLog: P2TRCanonicalBridgeLifecycleEventLog = {
      address: emitter,
      blockHash: txHash("88"),
      blockNumber: 60,
      data: "0x",
      logIndex: 2,
      removed: false,
      topics: [eventTopic],
      transactionHash: txHash("aa"),
    }
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
            logs: [canonicalLog],
          }
        },
        async getLogs(filter) {
          return filterCanonicalProviderLogs([canonicalLog], filter)
        },
      }
    )

    assert.equal(
      await verifier.verifyLifecycleLog({
        eventName,
        expectedEmitter: emitter,
        log: canonicalLog,
      }),
      true,
      eventName
    )
  }
})

test("rejects a submitted event returned by a defeated-event query", async () => {
  const sourceForEventTopic = (eventTopic: string) => {
    const canonicalLog: P2TRCanonicalBridgeLifecycleEventLog = {
      args: { challengeKey: 1n },
      address: `0x${"42".repeat(20)}`,
      blockHash: txHash("88"),
      blockNumber: 60,
      data: `0x${"0".repeat(63)}1${sighash().slice(2)}`,
      logIndex: 2,
      removed: false,
      topics: [
        eventTopic,
        walletID(),
        encodeIndexedBytes20Topic(walletPubKeyHash()),
        bridgeChallengeIdentity(),
      ],
      transactionHash: txHash("aa"),
    }
    const contract = new FakeBridgeLifecycleContract({
      defeated: [canonicalLog],
    })
    const canonicalLogVerifier =
      new EthersP2TRCanonicalBridgeLifecycleLogVerifier("canonical.example", {
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
            logs: [canonicalLog],
          }
        },
        async getLogs(filter) {
          return filterCanonicalProviderLogs([canonicalLog], filter)
        },
      })

    return new VerifiedEthersP2TRSignatureFraudBridgeLifecycleEventSource(
      contract,
      {
        sourceTrustDomainID: "indexer.example",
        canonicalLogVerifier,
        fromBlock: 50,
        toBlock: 88,
      }
    )
  }

  assert.deepEqual(
    (
      await sourceForEventTopic(
        challengeDefeatedEventTopic
      ).listBridgeLifecycleEvents()
    ).map((event) => event.type),
    ["defeated"]
  )
  await assert.rejects(
    sourceForEventTopic(
      challengeSubmittedEventTopic
    ).listBridgeLifecycleEvents(),
    /P2TRSignatureFraudChallengeDefeated log range is not independently complete/
  )
})

test("maps lifecycle arguments from independently verified log data", async () => {
  const emitter = `0x${"42".repeat(20)}`
  const canonicalChallengeKey = `0x${"0".repeat(63)}2`
  const canonicalLog: P2TRCanonicalBridgeLifecycleEventLog = {
    args: {
      walletID: txHash("aa"),
      bridgeChallengeIdentity: txHash("bb"),
      challengeKey: 999n,
      sighash: txHash("cc"),
    },
    address: emitter,
    blockHash: txHash("88"),
    blockNumber: 60,
    data: `${canonicalChallengeKey}${sighash().slice(2)}`,
    logIndex: 2,
    removed: false,
    topics: [
      challengeDefeatedEventTopic,
      walletID(),
      `${walletPubKeyHash()}${"0".repeat(24)}`,
      bridgeChallengeIdentity(),
    ],
    transactionHash: txHash("dd"),
  }
  const receiptLog = { ...canonicalLog, args: undefined }
  const contract = new FakeBridgeLifecycleContract({
    defeated: [canonicalLog],
  })
  const canonicalLogVerifier =
    new EthersP2TRCanonicalBridgeLifecycleLogVerifier("canonical.example", {
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
          logs: [receiptLog],
        }
      },
      async getLogs(filter) {
        return filterCanonicalProviderLogs([receiptLog], filter)
      },
    })
  const source = new VerifiedEthersP2TRSignatureFraudBridgeLifecycleEventSource(
    contract,
    {
      sourceTrustDomainID: "indexer.example",
      canonicalLogVerifier,
      fromBlock: 50,
      toBlock: 88,
    }
  )

  assert.deepEqual(await source.listBridgeLifecycleEvents(), [
    {
      type: "defeated",
      bridgeChallengeKey: canonicalChallengeKey,
      defeatTxHash: canonicalLog.transactionHash,
      walletID: walletID(),
      bridgeChallengeIdentity: bridgeChallengeIdentity(),
      sighash: sighash(),
    },
  ])
})

test("maps completed proof hashes from verified data with or without adapter args", async () => {
  const canonicalProofDataHash =
    "0x000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f"
  const expectedDisplayOrderHash =
    "0x1f1e1d1c1b1a191817161514131211100f0e0d0c0b0a09080706050403020100"

  const sourceForArgs = (args: P2TREthersBridgeLifecycleEventLog["args"]) => {
    const canonicalLog: P2TRCanonicalBridgeLifecycleEventLog = {
      args,
      address: `0x${"42".repeat(20)}`,
      blockHash: txHash("88"),
      blockNumber: 60,
      data: canonicalProofDataHash,
      logIndex: 2,
      removed: false,
      topics: [
        movingFundsCompletedEventTopic,
        encodeIndexedBytes20Topic(walletPubKeyHash()),
      ],
      transactionHash: txHash("dd"),
    }
    const receiptLog = { ...canonicalLog, args: undefined }
    const contract = new FakeBridgeLifecycleContract({
      movingFundsCompleted: [canonicalLog],
    })
    const canonicalLogVerifier =
      new EthersP2TRCanonicalBridgeLifecycleLogVerifier("canonical.example", {
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
            logs: [receiptLog],
          }
        },
        async getLogs(filter) {
          return filterCanonicalProviderLogs([receiptLog], filter)
        },
      })

    return new VerifiedEthersP2TRSignatureFraudBridgeLifecycleEventSource(
      contract,
      {
        sourceTrustDomainID: "indexer.example",
        canonicalLogVerifier,
        fromBlock: 50,
        toBlock: 88,
      }
    )
  }

  const adapterArgs: P2TREthersBridgeLifecycleEventLog["args"][] = [
    { movingFundsTxHash: txHash("cc") },
    [walletPubKeyHash(), txHash("cc")],
    undefined,
  ]

  for (const args of adapterArgs) {
    assert.deepEqual(await sourceForArgs(args).listBridgeLifecycleEvents(), [
      {
        type: "honest-spend-proven",
        bitcoinTxHash: expectedDisplayOrderHash,
        spendType: "moving-funds",
      },
    ])
  }
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
        blockNumber: 111,
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
        blockNumber: 110,
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
  const sourceProvider = fakeBridgeLifecycleProvider()
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
    ["defeated", "timedOut"],
    sourceProvider
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
    ["movingFundsCompleted", "redemptionsCompleted"],
    sourceProvider
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
      walletID: walletID(),
      bridgeChallengeIdentity: bridgeChallengeIdentity(),
      sighash: sighash(),
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
          blockNumber: 120,
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
          blockNumber: 130,
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
          blockNumber: 140,
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
          blockNumber: 130,
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
          blockNumber: 120,
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
          blockNumber: 130,
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
          blockNumber: 130,
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
  const contract = new FakeBridgeLifecycleContract({})
  for (const canonicalLogVerificationConcurrency of [
    0,
    1.5,
    Number.MAX_SAFE_INTEGER + 1,
  ]) {
    assert.throws(
      () =>
        new VerifiedEthersP2TRSignatureFraudBridgeLifecycleEventSource(
          contract,
          {
            sourceTrustDomainID: "indexer.example",
            canonicalLogVerifier: acceptingCanonicalVerifier(contract),
            canonicalLogVerificationConcurrency,
          }
        ),
      /canonical log verification concurrency must be a positive integer/
    )
  }

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
    /event data must contain exactly 2 ABI words/
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
    /event topic\[1\] must be 32 bytes/
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
    /event data must contain exactly 1 ABI words/
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
    /event data must contain exactly 1 ABI words/
  )

  const validChallengeData = `0x${"0".repeat(63)}1${sighash().slice(2)}`
  await assert.rejects(
    new EthersP2TRSignatureFraudBridgeLifecycleEventSource(
      new FakeBridgeLifecycleContract({
        defeated: [
          {
            args: { challengeKey: 1n },
            data: validChallengeData,
            topics: [
              challengeDefeatedEventTopic,
              walletID(),
              encodeIndexedBytes20Topic(walletPubKeyHash()),
              bridgeChallengeIdentity(),
              txHash("55"),
            ],
            transactionHash: txHash("f2"),
          },
        ],
      })
    ).listBridgeLifecycleEvents(),
    /event must contain exactly 4 topics/
  )

  await assert.rejects(
    new EthersP2TRSignatureFraudBridgeLifecycleEventSource(
      new FakeBridgeLifecycleContract({
        defeated: [
          {
            args: { challengeKey: 1n },
            data: validChallengeData,
            topics: [
              challengeDefeatedEventTopic,
              walletID(),
              `0x${"0".repeat(24)}${walletPubKeyHash().slice(2)}`,
              bridgeChallengeIdentity(),
            ],
            transactionHash: txHash("f3"),
          },
        ],
      })
    ).listBridgeLifecycleEvents(),
    /wallet public key hash must be right-padded to 32 bytes/
  )
})

test("rejects contracts without the required Bridge event filters", async () => {
  const source = new EthersP2TRSignatureFraudBridgeLifecycleEventSource(
    new FakeBridgeLifecycleContract({}, undefined, {}, [])
  )

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

function fakeBridgeLifecycleProvider(
  getHead: () => number = () => Number.MAX_SAFE_INTEGER,
  getBlockHash: (blockNumber: number) => string | undefined = () => undefined
): P2TREthersBridgeLifecycleProvider {
  return {
    async getBlockNumber() {
      return getHead()
    },
    async getBlock(blockNumber: number) {
      const hash = getBlockHash(blockNumber)
      return hash === undefined ? undefined : { hash }
    },
  }
}

class FakeBridgeLifecycleContract implements P2TREthersBridgeLifecycleContract {
  readonly address = `0x${"42".repeat(20)}`
  readonly provider: P2TREthersBridgeLifecycleProvider

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
    availableFilters: FakeBridgeLifecycleFilter[] = allFakeBridgeLifecycleFilters,
    sourceProvider?: P2TREthersBridgeLifecycleProvider
  ) {
    this.filters = buildFakeBridgeLifecycleFilters(availableFilters)

    this.provider =
      sourceProvider ??
      fakeBridgeLifecycleProvider(
        () => this.latestBlock ?? Number.MAX_SAFE_INTEGER,
        (blockNumber) => this.blockHashes[blockNumber]
      )
  }

  async queryFilter(
    filter: unknown,
    fromBlock?: number | string,
    toBlock?: number | string
  ): Promise<P2TREthersBridgeLifecycleEventLog[]> {
    this.queries.push({ filter, fromBlock, toBlock })

    if (filter === defeatedFilter) {
      return (this.logs.defeated ?? []).map((log) =>
        canonicalLogFixture(log, this.address, "defeated")
      )
    }

    if (filter === timedOutFilter) {
      return (this.logs.timedOut ?? []).map((log) =>
        canonicalLogFixture(log, this.address, "timedOut")
      )
    }

    if (filter === movingFundsCompletedFilter) {
      return (this.logs.movingFundsCompleted ?? []).map((log) =>
        canonicalLogFixture(log, this.address, "movingFundsCompleted")
      )
    }

    if (filter === redemptionsCompletedFilter) {
      return (this.logs.redemptionsCompleted ?? []).map((log) =>
        canonicalLogFixture(log, this.address, "redemptionsCompleted")
      )
    }

    throw new Error("unknown filter")
  }

  setBlockHash(blockNumber: number, blockHash: string): void {
    this.blockHashes[blockNumber] = blockHash
  }

  canonicalProviderBlockHash(blockNumber: number): string | undefined {
    return this.blockHashes[blockNumber]
  }

  canonicalProviderLogs(): P2TREthersBridgeLifecycleEventLog[] {
    return [
      ...(this.logs.defeated ?? []).map((log) =>
        canonicalLogFixture(log, this.address, "defeated")
      ),
      ...(this.logs.timedOut ?? []).map((log) =>
        canonicalLogFixture(log, this.address, "timedOut")
      ),
      ...(this.logs.movingFundsCompleted ?? []).map((log) =>
        canonicalLogFixture(log, this.address, "movingFundsCompleted")
      ),
      ...(this.logs.redemptionsCompleted ?? []).map((log) =>
        canonicalLogFixture(log, this.address, "redemptionsCompleted")
      ),
    ].map(cloneLifecycleLog)
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

class DeferredCanonicalLogVerifier
  implements P2TRCanonicalBridgeLifecycleLogVerifier
{
  readonly trustDomainID = "canonical.example"
  readonly providerIdentity = {}
  readonly startedTransactionHashes: string[] = []
  readonly completedTransactionHashes: string[] = []
  private readonly pending = new Map<string, (result: boolean) => void>()
  private activeCount = 0
  private maxActiveCount = 0

  get active(): number {
    return this.activeCount
  }

  get maxActive(): number {
    return this.maxActiveCount
  }

  async getBlockNumber(): Promise<number> {
    return Number.MAX_SAFE_INTEGER
  }

  async getCanonicalBlockHash(): Promise<string> {
    return txHash("99")
  }

  async verifyLifecycleLogRange(): Promise<boolean> {
    return true
  }

  verifyLifecycleLog({
    log,
  }: Parameters<
    P2TRCanonicalBridgeLifecycleLogVerifier["verifyLifecycleLog"]
  >[0]): Promise<boolean> {
    const transactionHash = log.transactionHash
    assert.equal(this.pending.has(transactionHash), false)
    this.startedTransactionHashes.push(transactionHash)
    this.activeCount++
    this.maxActiveCount = Math.max(this.maxActiveCount, this.activeCount)

    return new Promise((resolve) => {
      this.pending.set(transactionHash, (result) => {
        this.pending.delete(transactionHash)
        this.completedTransactionHashes.push(transactionHash)
        this.activeCount--
        resolve(result)
      })
    })
  }

  async release(transactionHash: string, result = true): Promise<void> {
    for (let attempt = 0; attempt < 100; attempt++) {
      const resolve = this.pending.get(transactionHash)
      if (resolve !== undefined) {
        resolve(result)
        return
      }

      await new Promise<void>((resolve) => setImmediate(resolve))
    }

    assert.fail(
      `Canonical verification did not start for transaction ${transactionHash}`
    )
  }
}

function acceptingCanonicalVerifier(
  ...contracts: P2TREthersBridgeLifecycleContract[]
): P2TRCanonicalBridgeLifecycleLogVerifier {
  const fixtureContracts = contracts
    .filter((contract, index) => contracts.indexOf(contract) === index)
    .map((contract) => {
      assert.ok(contract instanceof FakeBridgeLifecycleContract)
      return contract
    })
  const provider = new FakeIndependentCanonicalBridgeLifecycleProvider(
    fixtureContracts
  )

  for (const contract of fixtureContracts) {
    assert.notEqual(provider, contract.provider)
  }

  return new EthersP2TRCanonicalBridgeLifecycleLogVerifier(
    "canonical-rpc.test",
    provider
  )
}

function verifierWithProviderIdentity(
  verifier: P2TRCanonicalBridgeLifecycleLogVerifier,
  providerIdentity: object
): P2TRCanonicalBridgeLifecycleLogVerifier {
  return {
    trustDomainID: verifier.trustDomainID,
    providerIdentity,
    getBlockNumber: () => verifier.getBlockNumber(),
    getCanonicalBlockHash: (blockNumber) =>
      verifier.getCanonicalBlockHash(blockNumber),
    verifyLifecycleLogRange: (verification) =>
      verifier.verifyLifecycleLogRange(verification),
    verifyLifecycleLog: (verification) =>
      verifier.verifyLifecycleLog(verification),
  }
}

class FakeIndependentCanonicalBridgeLifecycleProvider
  implements P2TREthersCanonicalBridgeLifecycleProvider
{
  readonly providerIdentity = {}

  constructor(
    private readonly contracts: readonly FakeBridgeLifecycleContract[],
    private readonly additionalLogs: readonly P2TREthersBridgeLifecycleEventLog[] = []
  ) {}

  async getBlockNumber(): Promise<number> {
    const heads = this.contracts
      .map((contract) => contract.latestBlock)
      .filter((head): head is number => head !== undefined)

    return heads.length === 0 ? Number.MAX_SAFE_INTEGER : Math.min(...heads)
  }

  async getBlock(blockNumber: number): Promise<{ hash: string } | undefined> {
    for (const contract of this.contracts) {
      const hash = contract.canonicalProviderBlockHash(blockNumber)
      if (hash !== undefined) {
        return { hash }
      }
    }

    const logAtBlock = this.canonicalLogs().find(
      (log) => log.blockNumber === blockNumber
    )
    return { hash: logAtBlock?.blockHash ?? txHash("99") }
  }

  async getTransactionReceipt(transactionHash: string) {
    const receiptLogs = this.canonicalLogs().filter(
      (log) => log.transactionHash === transactionHash
    )
    const firstLog = receiptLogs[0]
    if (firstLog === undefined) {
      return undefined
    }

    return {
      status: 1,
      blockHash: firstLog.blockHash ?? txHash("99"),
      blockNumber: firstLog.blockNumber ?? 0,
      transactionHash,
      logs: receiptLogs,
    }
  }

  async getLogs(
    filter: Parameters<P2TREthersCanonicalBridgeLifecycleProvider["getLogs"]>[0]
  ): Promise<P2TREthersBridgeLifecycleEventLog[]> {
    return filterCanonicalProviderLogs(this.canonicalLogs(), filter)
  }

  private canonicalLogs(): P2TREthersBridgeLifecycleEventLog[] {
    return [
      ...this.contracts.flatMap((contract) => contract.canonicalProviderLogs()),
      ...this.additionalLogs.map(cloneLifecycleLog),
    ]
  }
}

function filterCanonicalProviderLogs(
  logs: readonly P2TREthersBridgeLifecycleEventLog[],
  filter: Parameters<P2TREthersCanonicalBridgeLifecycleProvider["getLogs"]>[0]
): P2TREthersBridgeLifecycleEventLog[] {
  return logs
    .filter((log) => {
      if (log.address?.toLowerCase() !== filter.address.toLowerCase()) {
        return false
      }

      if (
        !filter.topics.every(
          (topic, index) => log.topics?.[index]?.toLowerCase() === topic
        )
      ) {
        return false
      }

      if (
        typeof filter.fromBlock === "number" &&
        (log.blockNumber === undefined || log.blockNumber < filter.fromBlock)
      ) {
        return false
      }

      if (
        typeof filter.toBlock === "number" &&
        (log.blockNumber === undefined || log.blockNumber > filter.toBlock)
      ) {
        return false
      }

      return true
    })
    .map(cloneLifecycleLog)
}

function cloneLifecycleLog(
  log: P2TREthersBridgeLifecycleEventLog
): P2TREthersBridgeLifecycleEventLog {
  return {
    ...log,
    topics: log.topics === undefined ? undefined : [...log.topics],
  }
}

function canonicalLogFixture(
  log: P2TREthersBridgeLifecycleEventLog,
  address: string,
  event: FakeBridgeLifecycleFilter
): P2TREthersBridgeLifecycleEventLog {
  const rawEvent =
    event === "defeated" || event === "timedOut"
      ? challengeLifecycleRawEventFixture(log.args, event)
      : completedProofRawEventFixture(log.args, event)

  return {
    address,
    blockHash: txHash("99"),
    blockNumber: 0,
    logIndex: 0,
    removed: false,
    ...rawEvent,
    ...log,
  }
}

function challengeLifecycleRawEventFixture(
  args: P2TREthersBridgeLifecycleEventLog["args"],
  event: "defeated" | "timedOut"
): Pick<P2TREthersBridgeLifecycleEventLog, "data" | "topics"> {
  const challengeKey = testLogArg(args, "challengeKey", 3)
  const eventSighash = testLogArg(args, "sighash", 4) ?? sighash()
  const encodedChallengeKey =
    challengeKey === undefined ? undefined : encodeUint256Word(challengeKey)
  const data =
    encodedChallengeKey === undefined
      ? "0x"
      : `0x${encodedChallengeKey}${encodeFixedBytesWord(eventSighash)}`

  return {
    data,
    topics: [
      event === "defeated"
        ? challengeDefeatedEventTopic
        : challengeDefeatTimedOutEventTopic,
      String(testLogArg(args, "walletID", 0) ?? walletID()),
      encodeIndexedBytes20Topic(
        testLogArg(args, "walletPubKeyHash", 1) ?? walletPubKeyHash()
      ),
      String(
        testLogArg(args, "bridgeChallengeIdentity", 2) ??
          bridgeChallengeIdentity()
      ),
    ],
  }
}

function completedProofRawEventFixture(
  args: P2TREthersBridgeLifecycleEventLog["args"],
  event: "movingFundsCompleted" | "redemptionsCompleted"
): Pick<P2TREthersBridgeLifecycleEventLog, "data" | "topics"> {
  const namedField =
    event === "movingFundsCompleted" ? "movingFundsTxHash" : "redemptionTxHash"
  const bitcoinTxHash = testLogArg(args, namedField, 1)

  return {
    data:
      bitcoinTxHash === undefined
        ? "0x"
        : `0x${encodeFixedBytesWord(bitcoinTxHash)}`,
    topics: [
      event === "movingFundsCompleted"
        ? movingFundsCompletedEventTopic
        : redemptionsCompletedEventTopic,
      encodeIndexedBytes20Topic(
        testLogArg(args, "walletPubKeyHash", 0) ?? walletPubKeyHash()
      ),
    ],
  }
}

function testLogArg(
  args: P2TREthersBridgeLifecycleEventLog["args"],
  namedField: string,
  indexedField: number
): unknown {
  if (args === undefined) {
    return undefined
  }

  return (
    (args as Record<string, unknown>)[namedField] ??
    (args as readonly unknown[])[indexedField]
  )
}

function encodeUint256Word(value: unknown): string {
  let hex: string

  if (typeof value === "string") {
    hex = value.replace(/^(0x|0X)/, "")
  } else if (typeof value === "number" || typeof value === "bigint") {
    hex = BigInt(value).toString(16)
  } else if (
    typeof value === "object" &&
    value !== null &&
    "toHexString" in value &&
    typeof value.toHexString === "function"
  ) {
    hex = value.toHexString().replace(/^(0x|0X)/, "")
  } else {
    throw new Error("unsupported test uint256 value")
  }

  return hex.padStart(64, "0")
}

function encodeFixedBytesWord(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("unsupported test fixed-bytes value")
  }

  return value.replace(/^(0x|0X)/, "")
}

function encodeIndexedBytes20Topic(value: unknown): string {
  if (typeof value !== "string") {
    throw new Error("unsupported test bytes20 value")
  }

  return `0x${value.replace(/^(0x|0X)/, "")}${"0".repeat(24)}`
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
