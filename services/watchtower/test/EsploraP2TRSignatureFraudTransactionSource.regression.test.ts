import assert from "assert/strict"
import { promises as fs } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import test from "node:test"

import {
  BitcoinNetwork,
  BitcoinTxHash,
  Hex,
  P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION,
} from "@keep-network/tbtc-v2.ts"
import type { P2TRSignatureFraudWatchtowerBridgeLifecycleEventSource } from "@keep-network/tbtc-v2.ts"

import {
  deriveP2TRWalletAddress,
  EsploraP2TRSignatureFraudTransactionSource,
  FileBackedP2TRConfirmedHistoryCursorStore,
  P2TRSignatureFraudWatchtowerService,
} from "../src/index.js"
import type {
  P2TRCanonicalTaprootDepositRevealSource,
  P2TRConfirmedHistoryCursor,
  P2TRConfirmedHistoryCursorStore,
  P2TREsploraFetch,
  P2TRTaprootDepositBindingInventory,
  P2TRTaprootDepositRevealSource,
} from "../src/index.js"

/**
 * Committing the bridge-lifecycle cursor is an optional capability: the service
 * discovers it structurally (`hasBridgeLifecycleScanCommitter`) rather than
 * requiring it on the source interface. A double that provides it has to say so
 * in its type, or the excess-property check rejects the literal and the
 * contextual type never reaches `spendType`.
 */
type CommittingBridgeLifecycleEventSource =
  P2TRSignatureFraudWatchtowerBridgeLifecycleEventSource & {
    commitBridgeLifecycleScan(): Promise<void>
  }

const committingBridgeLifecycleSource = (
  source: CommittingBridgeLifecycleEventSource
): CommittingBridgeLifecycleEventSource => source

const walletID =
  "f9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9"
const secondWalletID =
  "e493dbf1c10d80f3581e4904930b1404cc6c13900ee0758474fa94abe8c4cd13"
const bridgeAddress = `0x${"11".repeat(20)}`

type RevealEvent = ReturnType<typeof revealEvent>

type RevealState = {
  head: number
  events: RevealEvent[]
  queriedRanges: Array<{ source: string; fromBlock: number; toBlock: number }>
}

type Outspend =
  | { spent: false }
  | {
      spent: true
      txid: string
      status: {
        confirmed: boolean
        block_hash?: string
        block_height?: number
      }
    }

class MutableRevealSource {
  readonly providerIdentity = {}

  constructor(
    private readonly state: RevealState,
    private readonly sourceName: string
  ) {}

  async getBlockNumber(): Promise<number> {
    return this.state.head
  }

  async getCanonicalBlockHash(blockNumber: number): Promise<string> {
    return blockHash(blockNumber)
  }

  async getTaprootDepositRevealedEvents(options?: {
    fromBlock?: number
    toBlock?: number
  }): Promise<RevealEvent[]> {
    const fromBlock = Number(options?.fromBlock ?? 0)
    const toBlock = Number(options?.toBlock ?? this.state.head)
    this.state.queriedRanges.push({
      source: this.sourceName,
      fromBlock,
      toBlock,
    })

    return this.state.events.filter(
      ({ blockNumber }) => blockNumber >= fromBlock && blockNumber <= toBlock
    )
  }

  async deposits(..._args: unknown[]): Promise<unknown> {
    return {
      depositor: { identifierHex: "23".repeat(20) },
      amount: scalar("100000"),
      revealedAt: 1,
      sweptAt: 0,
      treasuryFee: scalar("0"),
    }
  }

  async taprootDepositOutputKeyCommitment(..._args: unknown[]): Promise<Hex> {
    return Hex.from("99".repeat(32))
  }
}

class MemoryConfirmedHistoryCursorStore
  implements P2TRConfirmedHistoryCursorStore
{
  private readonly cursors = new Map<string, P2TRConfirmedHistoryCursor>()
  private inventory?: P2TRTaprootDepositBindingInventory

  async loadConfirmedHistoryCursor(address: string) {
    return clone(this.cursors.get(address))
  }

  async saveConfirmedHistoryCursor(
    address: string,
    cursor: P2TRConfirmedHistoryCursor
  ) {
    this.cursors.set(address, clone(cursor)!)
  }

  async loadTaprootDepositBindingInventory() {
    return clone(this.inventory)
  }

  async saveTaprootDepositBindingInventory(
    inventory: P2TRTaprootDepositBindingInventory
  ) {
    this.inventory = clone(inventory)
  }
}

class MutableBitcoinView {
  readonly requestedOutpoints: string[] = []
  readonly outspends = new Map<string, Outspend>()
  readonly rawTransactions = new Map<string, string>()

  readonly fetch: P2TREsploraFetch = async (input) => {
    const path = new URL(input).pathname

    if (path.includes("/txs/mempool") || path.includes("/txs/chain")) {
      return jsonResponse([])
    }

    const outspendMatch = path.match(/^\/tx\/([0-9a-f]{64})\/outspend\/(\d+)$/)
    if (outspendMatch !== null) {
      const outpoint = `${outspendMatch[1]}:${Number(outspendMatch[2])}`
      this.requestedOutpoints.push(outpoint)
      return jsonResponse(this.outspends.get(outpoint) ?? { spent: false })
    }

    const rawTransactionMatch = path.match(/^\/tx\/([0-9a-f]{64})\/hex$/)
    if (rawTransactionMatch !== null) {
      return new Response(
        this.rawTransactions.get(rawTransactionMatch[1]) ?? "020000000001"
      )
    }

    return new Response("not found", { status: 404 })
  }
}

type SourceOptions = {
  bitcoinNetwork?: BitcoinNetwork
  wallets?: string[]
  chainID?: unknown
  bridgeAddress?: string
  fromBlock?: number
  confirmationDepth?: number
  maxBlockRange?: number
  maxEventsPerRange?: number
  outspendLimit?: number
  inventoryLimit?: number
}

function createSource(
  revealState: RevealState,
  cursorStore: P2TRConfirmedHistoryCursorStore,
  bitcoinView: MutableBitcoinView,
  options: SourceOptions = {}
) {
  const primary = new MutableRevealSource(revealState, "primary")
  const canonical = new MutableRevealSource(revealState, "canonical")

  const source = new EsploraP2TRSignatureFraudTransactionSource(
    "https://esplora.test",
    options.bitcoinNetwork ?? BitcoinNetwork.Testnet,
    options.wallets ?? [walletID],
    {
      taprootDepositRevealSource:
        primary as unknown as P2TRTaprootDepositRevealSource,
      taprootDepositRevealSourceTrustDomainID: "primary.test",
      canonicalTaprootDepositRevealSource: {
        ...(canonical as unknown as P2TRTaprootDepositRevealSource),
        providerIdentity: canonical.providerIdentity,
        trustDomainID: "canonical.test",
        getBlockNumber: () => canonical.getBlockNumber(),
        getCanonicalBlockHash: (blockNumber) =>
          canonical.getCanonicalBlockHash(blockNumber),
        getTaprootDepositRevealedEvents: (range) =>
          canonical.getTaprootDepositRevealedEvents(range as never) as never,
        deposits: (...args: unknown[]) => canonical.deposits(...args) as never,
        taprootDepositOutputKeyCommitment: (...args: unknown[]) =>
          canonical.taprootDepositOutputKeyCommitment(...args) as never,
      } as P2TRCanonicalTaprootDepositRevealSource,
      confirmedHistoryCursorStore: cursorStore,
      onDepositScanFailure: () => undefined,
      fetchFn: bitcoinView.fetch,
      maxAttempts: 1,
      retryDelayMs: 0,
      requestTimeoutMs: 1000,
      confirmedPageLimit: 1,
      depositScanConcurrency: 2,
      taprootDepositRevealChainID: options.chainID ?? "1",
      taprootDepositRevealBridgeAddress: options.bridgeAddress ?? bridgeAddress,
      taprootDepositRevealFromBlock: options.fromBlock ?? 0,
      taprootDepositRevealConfirmationDepth: options.confirmationDepth ?? 0,
      taprootDepositRevealMaxBlockRange: options.maxBlockRange ?? 100,
      taprootDepositRevealMaxEventsPerRange: options.maxEventsPerRange ?? 100,
      depositOutspendScanLimit: options.outspendLimit ?? 100,
      taprootDepositBindingInventoryLimit: options.inventoryLimit ?? 100,
    }
  )

  return { source, primary }
}

test("adaptively shrinks dense reveal ranges and persists progress across restarts", async () => {
  const directory = await fs.mkdtemp(join(tmpdir(), "p2tr-reveal-range-"))
  const cursorPath = join(directory, "confirmed-history.json")
  const revealState: RevealState = {
    head: 3,
    events: [0, 1, 2, 3].map((block, index) => revealEvent(block, index + 1)),
    queriedRanges: [],
  }
  const bitcoinView = new MutableBitcoinView()

  try {
    const completed: boolean[] = []
    for (let expectedBlock = 0; expectedBlock <= 3; expectedBlock++) {
      const store = new FileBackedP2TRConfirmedHistoryCursorStore(cursorPath)
      const { source } = createSource(revealState, store, bitcoinView, {
        maxBlockRange: 4,
        maxEventsPerRange: 1,
      })

      const result = await source.listConfirmedTransactions()
      completed.push(result.complete)
      await source.commitConfirmedTransactionScan()

      const restartedStore = new FileBackedP2TRConfirmedHistoryCursorStore(
        cursorPath
      )
      const inventory =
        await restartedStore.loadTaprootDepositBindingInventory()
      assert.equal(inventory?.lastScannedBlock, expectedBlock)
      assert.equal(inventory?.bindings.length, expectedBlock + 1)
    }

    assert.deepEqual(completed, [false, false, false, false])
    assert.ok(
      revealState.queriedRanges.some(
        ({ fromBlock, toBlock }) => fromBlock === 0 && toBlock === 3
      )
    )
    assert.ok(
      revealState.queriedRanges.some(
        ({ fromBlock, toBlock }) => fromBlock === 0 && toBlock === 0
      )
    )
  } finally {
    await fs.rm(directory, { recursive: true, force: true })
  }
})

test("fails closed when a single reveal block exceeds the event bound", async () => {
  const store = new MemoryConfirmedHistoryCursorStore()
  const revealState: RevealState = {
    head: 0,
    events: [revealEvent(0, 1), revealEvent(0, 2)],
    queriedRanges: [],
  }
  const bitcoinView = new MutableBitcoinView()
  const { source } = createSource(revealState, store, bitcoinView, {
    maxEventsPerRange: 1,
  })

  await assert.rejects(
    source.listConfirmedTransactions(),
    /block 0 exceeds the configured 1-event bound/
  )
  await source.commitConfirmedTransactionScan()
  assert.equal(await store.loadTaprootDepositBindingInventory(), undefined)
  assert.deepEqual(bitcoinView.requestedOutpoints, [])
})

test("configuration fingerprint changes rebuild reveal inventory from the configured boundary", async (context) => {
  const cases: Array<{
    name: string
    variant: SourceOptions
    expectedFromBlock: number
    expectedBindings?: number
  }> = [
    { name: "Ethereum chain", variant: { chainID: "2" }, expectedFromBlock: 0 },
    {
      name: "Bridge address",
      variant: { bridgeAddress: `0x${"22".repeat(20)}` },
      expectedFromBlock: 0,
    },
    {
      name: "Bitcoin network",
      variant: { bitcoinNetwork: BitcoinNetwork.Mainnet },
      expectedFromBlock: 0,
    },
    {
      name: "from block",
      variant: { fromBlock: 1 },
      expectedFromBlock: 1,
      expectedBindings: 0,
    },
    {
      name: "confirmation depth",
      variant: { confirmationDepth: 1 },
      expectedFromBlock: 0,
    },
    {
      name: "wallet set",
      variant: { wallets: [walletID, secondWalletID] },
      expectedFromBlock: 0,
      expectedBindings: 2,
    },
  ]

  for (const testCase of cases) {
    await context.test(testCase.name, async () => {
      const store = new MemoryConfirmedHistoryCursorStore()
      const revealState: RevealState = {
        head: 2,
        events: [
          revealEvent(0, 1, walletID),
          revealEvent(1, 2, secondWalletID),
        ],
        queriedRanges: [],
      }
      const bitcoinView = new MutableBitcoinView()

      const baseline = createSource(revealState, store, bitcoinView)
      await baseline.source.listConfirmedTransactions()
      await baseline.source.commitConfirmedTransactionScan()
      const baselineInventory = await store.loadTaprootDepositBindingInventory()
      assert.equal(baselineInventory?.bindings.length, 1)

      revealState.queriedRanges.length = 0
      const restarted = createSource(
        revealState,
        store,
        bitcoinView,
        testCase.variant
      )
      await restarted.source.listConfirmedTransactions()
      await restarted.source.commitConfirmedTransactionScan()

      const firstPrimaryRange = revealState.queriedRanges.find(
        ({ source }) => source === "primary"
      )
      assert.equal(firstPrimaryRange?.fromBlock, testCase.expectedFromBlock)

      const rebuiltInventory = await store.loadTaprootDepositBindingInventory()
      assert.notEqual(
        rebuiltInventory?.configurationFingerprint,
        baselineInventory?.configurationFingerprint
      )
      assert.equal(
        rebuiltInventory?.bindings.length,
        testCase.expectedBindings ?? 1
      )
    })
  }
})

test("continues an outspend sweep through bindings added above its old anchor", async () => {
  const store = new MemoryConfirmedHistoryCursorStore()
  const revealState: RevealState = {
    head: 1,
    events: [revealEvent(0, 1), revealEvent(1, 2)],
    queriedRanges: [],
  }
  const bitcoinView = new MutableBitcoinView()

  const first = createSource(revealState, store, bitcoinView, {
    outspendLimit: 1,
  })
  const firstResult = await first.source.listConfirmedTransactions()
  assert.equal(firstResult.complete, false)
  await first.source.commitConfirmedTransactionScan()
  assert.deepEqual(bitcoinView.requestedOutpoints, [outpoint(1)])

  revealState.events.push(revealEvent(2, 3))
  revealState.head = 2
  bitcoinView.requestedOutpoints.length = 0

  const second = createSource(revealState, store, bitcoinView, {
    outspendLimit: 1,
  })
  const secondResult = await second.source.listConfirmedTransactions()
  assert.equal(secondResult.complete, false)
  await second.source.commitConfirmedTransactionScan()
  assert.deepEqual(bitcoinView.requestedOutpoints, [outpoint(2)])

  bitcoinView.requestedOutpoints.length = 0
  const third = createSource(revealState, store, bitcoinView, {
    outspendLimit: 1,
  })
  const thirdResult = await third.source.listConfirmedTransactions()
  assert.equal(thirdResult.complete, false)
  await third.source.commitConfirmedTransactionScan()
  assert.deepEqual(bitcoinView.requestedOutpoints, [outpoint(3)])
  assert.equal(
    (await store.loadTaprootDepositBindingInventory())?.outspendSweep,
    undefined
  )
})

test("revalidates a confirmed-spend tombstone after reorg and observes its replacement", async () => {
  const store = new MemoryConfirmedHistoryCursorStore()
  const revealState: RevealState = {
    head: 0,
    events: [revealEvent(0, 1)],
    queriedRanges: [],
  }
  const bitcoinView = new MutableBitcoinView()
  const firstSpend = hex32(201)
  const replacementSpend = hex32(202)

  bitcoinView.outspends.set(outpoint(1), confirmedOutspend(firstSpend, 10))
  let restarted = createSource(revealState, store, bitcoinView)
  let result = await restarted.source.listConfirmedTransactions()
  assert.deepEqual(
    result.transactions.map(({ bitcoinTxHash }) => bitcoinTxHash.toString()),
    [firstSpend]
  )
  await restarted.source.commitConfirmedTransactionScan()
  let binding = (await store.loadTaprootDepositBindingInventory())?.bindings[0]
  assert.equal(binding?.spendStatus, "confirmed-spent")
  assert.equal(binding?.confirmedSpendingTxid, firstSpend)

  bitcoinView.outspends.set(outpoint(1), { spent: false })
  restarted = createSource(revealState, store, bitcoinView)
  result = await restarted.source.listConfirmedTransactions()
  assert.deepEqual(result.transactions, [])
  await restarted.source.commitConfirmedTransactionScan()
  binding = (await store.loadTaprootDepositBindingInventory())?.bindings[0]
  assert.equal(binding?.spendStatus, "active")
  assert.equal(binding?.confirmedSpendingTxid, undefined)

  bitcoinView.outspends.set(
    outpoint(1),
    confirmedOutspend(replacementSpend, 11)
  )
  restarted = createSource(revealState, store, bitcoinView)
  result = await restarted.source.listConfirmedTransactions()
  assert.deepEqual(
    result.transactions.map(({ bitcoinTxHash }) => bitcoinTxHash.toString()),
    [replacementSpend]
  )
  await restarted.source.commitConfirmedTransactionScan()
  binding = (await store.loadTaprootDepositBindingInventory())?.bindings[0]
  assert.equal(binding?.spendStatus, "confirmed-spent")
  assert.equal(binding?.confirmedSpendingTxid, replacementSpend)
})

test("does not claim a multi-cycle outspend view is complete when an early binding changed", async () => {
  const store = new MemoryConfirmedHistoryCursorStore()
  const revealState: RevealState = {
    head: 1,
    events: [revealEvent(0, 1), revealEvent(1, 2)],
    queriedRanges: [],
  }
  const bitcoinView = new MutableBitcoinView()

  let restarted = createSource(revealState, store, bitcoinView, {
    outspendLimit: 1,
  })
  const first = await restarted.source.listConfirmedTransactions()
  assert.equal(first.complete, false)
  await restarted.source.commitConfirmedTransactionScan()
  assert.notEqual(
    (await store.loadTaprootDepositBindingInventory())?.outspendSweep,
    undefined
  )

  // The first entry changes after it was checked but before the old sweep
  // reaches its anchor. A true result here could allow an unmatched lifecycle
  // proof to be committed even though this spend was never observed.
  bitcoinView.outspends.set(outpoint(1), confirmedOutspend(hex32(203), 12))
  bitcoinView.requestedOutpoints.length = 0
  restarted = createSource(revealState, store, bitcoinView, {
    outspendLimit: 1,
  })
  let committedBridgeLifecycleScan = false
  const lifecycleSource: CommittingBridgeLifecycleEventSource = {
    async listBridgeLifecycleEvents() {
      return [
        {
          type: "honest-spend-proven" as const,
          bitcoinTxHash: `0x${hex32(203)}`,
          spendType: P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION,
        },
      ]
    },
    async commitBridgeLifecycleScan() {
      committedBridgeLifecycleScan = true
    },
  }
  const service = new P2TRSignatureFraudWatchtowerService(
    {
      registeredWalletIDs: [`0x${walletID}`],
      submitChallenges: false,
    },
    {
      bitcoinClient: {} as never,
      transactionSource: restarted.source,
      bridgeLifecycleEventSource: lifecycleSource,
      persistence: {
        async loadChallengeRecords() {
          return []
        },
        async saveChallengeRecords() {},
      },
    }
  )
  const second = await service.processCycle()

  assert.deepEqual(bitcoinView.requestedOutpoints, [outpoint(2)])
  assert.equal(
    second.result.confirmedSourceComplete,
    false,
    "a multi-cycle current-state poll is not a canonical complete snapshot"
  )
  assert.equal(second.result.bridgeLifecycle.ignored.length, 1)
  assert.equal(committedBridgeLifecycleScan, false)
  assert.equal(
    (await store.loadTaprootDepositBindingInventory())?.outspendSweep,
    undefined,
    "the confirmed-source inventory progress still commits while incomplete"
  )
})

test("does not certify an empty Esplora inventory or drop an unmatched lifecycle proof", async () => {
  const store = new MemoryConfirmedHistoryCursorStore()
  const revealState: RevealState = {
    head: 0,
    events: [],
    queriedRanges: [],
  }
  const bitcoinView = new MutableBitcoinView()
  const { source } = createSource(revealState, store, bitcoinView)
  let lifecycleListCount = 0
  let lifecycleCommitCount = 0
  const service = new P2TRSignatureFraudWatchtowerService(
    {
      registeredWalletIDs: [`0x${walletID}`],
      submitChallenges: false,
    },
    {
      bitcoinClient: {} as never,
      transactionSource: source,
      bridgeLifecycleEventSource: committingBridgeLifecycleSource({
        async listBridgeLifecycleEvents() {
          lifecycleListCount++
          return [
            {
              type: "honest-spend-proven" as const,
              bitcoinTxHash: `0x${hex32(204)}`,
              spendType: P2TR_SIGNATURE_FRAUD_SPEND_TYPE_REDEMPTION,
            },
          ]
        },
        async commitBridgeLifecycleScan() {
          lifecycleCommitCount++
        },
      }),
      persistence: {
        async loadChallengeRecords() {
          return []
        },
        async saveChallengeRecords() {},
      },
    }
  )

  for (let cycle = 0; cycle < 2; cycle++) {
    const report = await service.processCycle()
    assert.equal(report.result.confirmedSourceComplete, false)
    assert.equal(report.result.bridgeLifecycle.ignored.length, 1)
  }

  assert.equal(lifecycleListCount, 2, "the unmatched proof remains replayable")
  assert.equal(lifecycleCommitCount, 0)
  assert.deepEqual(
    await store.loadConfirmedHistoryCursor(
      deriveP2TRWalletAddress(walletID, BitcoinNetwork.Testnet)
    ),
    {},
    "confirmed-history progress still commits while the source is incomplete"
  )
  assert.equal(
    (await store.loadTaprootDepositBindingInventory())?.bindings.length,
    0
  )
})

test("fails closed before persisting an inventory above the hard lifetime bound", async () => {
  const store = new MemoryConfirmedHistoryCursorStore()
  const revealState: RevealState = {
    head: 1,
    events: [revealEvent(0, 1), revealEvent(1, 2)],
    queriedRanges: [],
  }
  const bitcoinView = new MutableBitcoinView()
  const { source } = createSource(revealState, store, bitcoinView, {
    inventoryLimit: 1,
  })

  await assert.rejects(
    source.listConfirmedTransactions(),
    /inventory exceeds the configured 1-binding bound/
  )
  await source.commitConfirmedTransactionScan()
  assert.equal(await store.loadTaprootDepositBindingInventory(), undefined)
  assert.deepEqual(bitcoinView.requestedOutpoints, [])
})

function revealEvent(
  blockNumber: number,
  id: number,
  eventWalletID = walletID
) {
  return {
    blockNumber,
    blockHash: Hex.from(blockHash(blockNumber)),
    transactionHash: Hex.from(hex32(1000 + id)),
    fundingTxHash: BitcoinTxHash.from(hex32(id)),
    fundingOutputIndex: 0,
    depositor: { identifierHex: "23".repeat(20) },
    amount: scalar("100000"),
    blindingFactor: Hex.from(id.toString(16).padStart(16, "0")),
    walletPublicKeyHash: Hex.from("25".repeat(20)),
    walletXOnlyPublicKey: Hex.from(eventWalletID),
    refundPublicKeyHash: Hex.from("26".repeat(20)),
    refundXOnlyPublicKey: Hex.from(secondWalletID),
    refundLocktime: Hex.from("00000000"),
  }
}

function confirmedOutspend(txid: string, blockHeight: number): Outspend {
  return {
    spent: true,
    txid,
    status: {
      confirmed: true,
      block_hash: hex32(5000 + blockHeight),
      block_height: blockHeight,
    },
  }
}

function outpoint(id: number): string {
  return `${hex32(id)}:0`
}

function blockHash(blockNumber: number): string {
  return hex32(10_000 + blockNumber)
}

function hex32(value: number): string {
  return value.toString(16).padStart(64, "0")
}

function scalar(value: string) {
  return { toString: () => value }
}

function clone<T>(value: T | undefined): T | undefined {
  return value === undefined
    ? undefined
    : (JSON.parse(JSON.stringify(value)) as T)
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), {
    headers: { "content-type": "application/json" },
  })
}
