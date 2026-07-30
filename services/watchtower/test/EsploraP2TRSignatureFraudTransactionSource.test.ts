import assert from "assert/strict"
import test from "node:test"

import {
  BitcoinNetwork,
  BitcoinTxHash,
  DepositScript,
  DepositScriptType,
  Hex,
} from "@keep-network/tbtc-v2.ts"

import {
  EsploraP2TRSignatureFraudTransactionSource as VerifiedEsploraP2TRSignatureFraudTransactionSource,
  P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV,
  P2TREsploraFetch,
  P2TRTaprootDepositRevealSource,
  createEsploraP2TRTransactionSourceFromRuntimeConfig,
  deriveP2TRWalletAddress,
  loadP2TRSignatureFraudWatchtowerRuntimeConfig,
} from "../src/index.js"
import type {
  EsploraP2TRSignatureFraudTransactionSourceOptions,
  P2TRCanonicalTaprootDepositRevealSource,
  P2TRConfirmedHistoryCursor,
  P2TRConfirmedHistoryCursorStore,
  P2TRDepositScanFailure,
  P2TRTaprootDepositBindingInventory,
} from "../src/index.js"

type FakeRoute = {
  status?: number
  body: unknown
}

const walletID =
  "0xf9308a019258c31049344f85f89d5229b531c845836f99b08601f113bce036f9"
const secondWalletID =
  "0xe493dbf1c10d80f3581e4904930b1404cc6c13900ee0758474fa94abe8c4cd13"
const mempoolTxid = "aa".repeat(32)
const secondMempoolTxid = "bb".repeat(32)
const confirmedTxid = "cc".repeat(32)
const nextConfirmedTxid = "dd".repeat(32)
const blockHash = "ee".repeat(32)
const rawMempoolTx = "020000000001"
const secondRawMempoolTx = "020000000002"
const rawConfirmedTx = "020000000003"
const nextRawConfirmedTx = "020000000004"
const fundingTxid = "12".repeat(32)

const emptyTaprootDepositRevealSource = taprootDepositRevealSource([])
const ignoreDepositScanFailure = () => undefined

type TestEsploraOptions = Omit<
  EsploraP2TRSignatureFraudTransactionSourceOptions,
  | "taprootDepositRevealSourceTrustDomainID"
  | "canonicalTaprootDepositRevealSource"
  | "confirmedHistoryCursorStore"
  | "taprootDepositRevealSource"
  | "taprootDepositRevealChainID"
  | "taprootDepositRevealBridgeAddress"
> & {
  confirmedHistoryCursorStore?: P2TRConfirmedHistoryCursorStore
  taprootDepositRevealSource: Omit<
    P2TRTaprootDepositRevealSource,
    "providerIdentity" | "getBlockNumber" | "getCanonicalBlockHash"
  > &
    Partial<
      Pick<
        P2TRTaprootDepositRevealSource,
        "providerIdentity" | "getBlockNumber" | "getCanonicalBlockHash"
      >
    >
  taprootDepositRevealChainID?: string
  taprootDepositRevealBridgeAddress?: string
}

class EsploraP2TRSignatureFraudTransactionSource extends VerifiedEsploraP2TRSignatureFraudTransactionSource {
  constructor(
    baseUrl: string,
    bitcoinNetwork: BitcoinNetwork,
    registeredWalletIDs: string[],
    options: TestEsploraOptions
  ) {
    if (options === undefined) {
      super(baseUrl, bitcoinNetwork, registeredWalletIDs, options as never)
      return
    }

    const primarySource = withRevealSourceVerification(
      options.taprootDepositRevealSource
    )

    super(baseUrl, bitcoinNetwork, registeredWalletIDs, {
      ...options,
      taprootDepositRevealSource: primarySource,
      taprootDepositRevealChainID:
        options.taprootDepositRevealChainID ?? "31337",
      taprootDepositRevealBridgeAddress:
        options.taprootDepositRevealBridgeAddress ?? `0x${"11".repeat(20)}`,
      taprootDepositRevealSourceTrustDomainID: "indexer.test",
      canonicalTaprootDepositRevealSource:
        independentTaprootDepositRevealSource(primarySource),
      confirmedHistoryCursorStore:
        options.confirmedHistoryCursorStore ??
        new MemoryConfirmedHistoryCursorStore(),
    })
  }
}

class MemoryConfirmedHistoryCursorStore
  implements P2TRConfirmedHistoryCursorStore
{
  private readonly cursors = new Map<string, P2TRConfirmedHistoryCursor>()
  private inventory?: P2TRTaprootDepositBindingInventory

  async loadConfirmedHistoryCursor(address: string) {
    return structuredClone(this.cursors.get(address))
  }

  async saveConfirmedHistoryCursor(
    address: string,
    cursor: P2TRConfirmedHistoryCursor
  ) {
    this.cursors.set(address, structuredClone(cursor))
  }

  async loadTaprootDepositBindingInventory() {
    return structuredClone(this.inventory)
  }

  async saveTaprootDepositBindingInventory(
    inventory: P2TRTaprootDepositBindingInventory
  ) {
    this.inventory = structuredClone(inventory)
  }
}

test("derives P2TR wallet addresses from canonical x-only wallet IDs", () => {
  assert.equal(
    deriveP2TRWalletAddress(walletID, BitcoinNetwork.Testnet),
    "tb1plycg5qvjtrp3qjf5f7zl382j9x6nrjz9sdhenvyxq8c3808qxmuswq2wgh"
  )
  // testnet4 shares testnet3's `tb` bech32 HRP, so the P2TR address is identical.
  assert.equal(
    deriveP2TRWalletAddress(walletID, BitcoinNetwork.Testnet4),
    "tb1plycg5qvjtrp3qjf5f7zl382j9x6nrjz9sdhenvyxq8c3808qxmuswq2wgh"
  )
  assert.equal(
    deriveP2TRWalletAddress(walletID, BitcoinNetwork.Mainnet),
    "bc1plycg5qvjtrp3qjf5f7zl382j9x6nrjz9sdhenvyxq8c3808qxmusegupjc"
  )
})

test("lists unique Esplora mempool P2TR wallet transactions", async () => {
  const firstAddress = deriveP2TRWalletAddress(walletID, BitcoinNetwork.Testnet)
  const secondAddress = deriveP2TRWalletAddress(
    secondWalletID,
    BitcoinNetwork.Testnet
  )
  const requestedPaths: string[] = []
  const source = new EsploraP2TRSignatureFraudTransactionSource(
    "https://esplora.test/",
    BitcoinNetwork.Testnet,
    [walletID, secondWalletID],
    {
      taprootDepositRevealSource: emptyTaprootDepositRevealSource,
      onDepositScanFailure: ignoreDepositScanFailure,
      fetchFn: fakeFetch(
        {
          [addressMempoolPath(firstAddress)]: [{ txid: `0x${mempoolTxid}` }],
          [addressMempoolPath(secondAddress)]: [
            { txid: mempoolTxid },
            { txid: secondMempoolTxid },
          ],
          [`/tx/${mempoolTxid}/hex`]: `0x${rawMempoolTx}`,
          [`/tx/${secondMempoolTxid}/hex`]: secondRawMempoolTx,
        },
        requestedPaths
      ),
    }
  )

  const transactions = await source.listMempoolTransactions()

  assert.deepEqual(
    transactions.map((transaction) => transaction.bitcoinTxHash.toString()),
    [mempoolTxid, secondMempoolTxid]
  )
  assert.deepEqual(
    transactions.map(
      (transaction) => transaction.rawTransaction.transactionHex
    ),
    [rawMempoolTx, secondRawMempoolTx]
  )
  assert.equal(
    requestedPaths.filter((path) => path === `/tx/${mempoolTxid}/hex`).length,
    1
  )
})

test("discovers mempool spends of revealed Taproot deposit outpoints", async () => {
  const address = deriveP2TRWalletAddress(walletID, BitcoinNetwork.Testnet)
  const requestedPaths: string[] = []
  const event = taprootDepositEvent()
  const extraData = Hex.from("27".repeat(32))
  const expectedOutputKey = (
    await DepositScript.fromReceipt(
      { ...(event as object), extraData } as never,
      DepositScriptType.P2TR
    ).getTaprootOutputKey()
  ).toString()
  const outputKeyWithoutExtraData = (
    await DepositScript.fromReceipt(
      event as never,
      DepositScriptType.P2TR
    ).getTaprootOutputKey()
  ).toString()
  const source = new EsploraP2TRSignatureFraudTransactionSource(
    "https://esplora.test",
    BitcoinNetwork.Testnet,
    [walletID],
    {
      taprootDepositRevealSource: taprootDepositRevealSource(
        [event],
        extraData
      ),
      onDepositScanFailure: ignoreDepositScanFailure,
      fetchFn: fakeFetch(
        {
          [addressMempoolPath(address)]: [],
          [depositOutspendPath(fundingTxid, 2)]: {
            spent: true,
            txid: mempoolTxid,
            status: { confirmed: false },
          },
          [`/tx/${mempoolTxid}/hex`]: rawMempoolTx,
        },
        requestedPaths
      ),
    }
  )

  const transactions = await source.listMempoolTransactions()

  assert.equal(transactions.length, 1)
  assert.equal(transactions[0].bitcoinTxHash.toString(), mempoolTxid)
  const [binding] = transactions[0].walletInputKeyBindings ?? []
  assert.equal(String(binding.txid), fundingTxid)
  assert.equal(binding.vout, 2)
  assert.equal(String(binding.walletID), walletID.slice(2))
  assert.equal(String(binding.outputKey), expectedOutputKey)
  assert.notEqual(String(binding.outputKey), outputKeyWithoutExtraData)
  assert.notEqual(String(binding.outputKey), walletID.slice(2))
  assert.ok(requestedPaths.includes(depositOutspendPath(fundingTxid, 2)))
})

test("bounds historical deposit scan work across every RPC stage", async () => {
  const address = deriveP2TRWalletAddress(walletID, BitcoinNetwork.Testnet)
  const concurrency = 2
  const fundingTxids = Array.from({ length: 5 }, (_, index) =>
    (0x31 + index).toString(16).repeat(32)
  )
  const spendingTxids = Array.from({ length: 5 }, (_, index) =>
    (0x41 + index).toString(16).repeat(32)
  )
  const commitmentProbe = createConcurrencyProbe()
  const depositRequestProbe = createConcurrencyProbe()
  const outspendProbe = createConcurrencyProbe()
  const rawTransactionProbe = createConcurrencyProbe()
  const routes: Record<string, FakeRoute["body"] | FakeRoute> = {
    [addressMempoolPath(address)]: [],
  }

  fundingTxids.forEach((txid, index) => {
    routes[depositOutspendPath(txid, index)] = {
      spent: true,
      txid: spendingTxids[index],
      status: { confirmed: false },
    }
    routes[`/tx/${spendingTxids[index]}/hex`] = rawMempoolTx
  })

  const baseFetch = fakeFetch(routes)
  const source = new EsploraP2TRSignatureFraudTransactionSource(
    "https://esplora.test",
    BitcoinNetwork.Testnet,
    [walletID],
    {
      taprootDepositRevealSource: {
        async getTaprootDepositRevealedEvents() {
          return fundingTxids.map((txid, index) =>
            taprootDepositEvent({
              fundingTxHash: BitcoinTxHash.from(txid),
              fundingOutputIndex: index,
            })
          ) as never[]
        },
        async taprootDepositOutputKeyCommitment() {
          return commitmentProbe.track(() => Hex.from("01".repeat(32)))
        },
        async deposits() {
          return depositRequestProbe.track(
            () =>
              ({
                depositor: { identifierHex: "23".repeat(20) },
                revealedAt: 1,
                treasuryFee: { toString: () => "0" },
              } as never)
          )
        },
      },
      onDepositScanFailure: ignoreDepositScanFailure,
      depositScanConcurrency: concurrency,
      fetchFn: async (input, init) => {
        const path = new URL(input).pathname
        if (path.includes("/outspend/")) {
          return outspendProbe.track(() => baseFetch(input, init))
        }
        if (path.endsWith("/hex")) {
          return rawTransactionProbe.track(() => baseFetch(input, init))
        }
        return baseFetch(input, init)
      },
    }
  )

  const transactions = await source.listMempoolTransactions()

  assert.deepEqual(
    transactions.map(({ bitcoinTxHash }) => bitcoinTxHash.toString()),
    spendingTxids
  )
  for (const probe of [commitmentProbe, depositRequestProbe]) {
    assert.equal(probe.started, fundingTxids.length * 2)
    assert.equal(probe.maxInFlight, concurrency)
  }
  for (const probe of [outspendProbe, rawTransactionProbe]) {
    assert.equal(probe.started, fundingTxids.length)
    assert.equal(probe.maxInFlight, concurrency)
  }
})

test("shares raw transaction concurrency across mempool and confirmed listings", async () => {
  const address = deriveP2TRWalletAddress(walletID, BitcoinNetwork.Testnet)
  const concurrency = 2
  const mempoolTxids = ["51".repeat(32), "52".repeat(32), "53".repeat(32)]
  const confirmedTxids = ["61".repeat(32), "62".repeat(32), "63".repeat(32)]
  const rawTransactionProbe = createConcurrencyProbe()
  const routes: Record<string, FakeRoute["body"] | FakeRoute> = {
    [addressMempoolPath(address)]: mempoolTxids.map((txid) => ({ txid })),
    [addressConfirmedPath(address)]: confirmedTxids.map((txid, index) =>
      confirmedSummary(txid, blockHash, 100 + index)
    ),
    [`${addressConfirmedPath(address)}/${confirmedTxids[2]}`]: [],
  }
  const transactionIDs = [...mempoolTxids, ...confirmedTxids]
  transactionIDs.forEach((txid) => {
    routes[`/tx/${txid}/hex`] = rawMempoolTx
  })
  const baseFetch = fakeFetch(routes)
  const source = new EsploraP2TRSignatureFraudTransactionSource(
    "https://esplora.test",
    BitcoinNetwork.Testnet,
    [walletID],
    {
      taprootDepositRevealSource: emptyTaprootDepositRevealSource,
      onDepositScanFailure: ignoreDepositScanFailure,
      depositScanConcurrency: concurrency,
      fetchFn: async (input, init) => {
        const path = new URL(input).pathname
        return path.endsWith("/hex")
          ? rawTransactionProbe.track(() => baseFetch(input, init))
          : baseFetch(input, init)
      },
    }
  )

  const [mempoolTransactions, confirmedTransactions] = await Promise.all([
    source.listMempoolTransactions(),
    source.listConfirmedTransactions(),
  ])

  assert.deepEqual(
    mempoolTransactions.map(({ bitcoinTxHash }) => bitcoinTxHash.toString()),
    mempoolTxids
  )
  assert.deepEqual(
    confirmedTransactions.transactions.map(({ bitcoinTxHash }) =>
      bitcoinTxHash.toString()
    ),
    confirmedTxids
  )
  assert.equal(confirmedTransactions.complete, false)
  assert.equal(rawTransactionProbe.started, 6)
  assert.equal(rawTransactionProbe.maxInFlight, concurrency)
})

test("excludes revealed deposits without an output-key commitment", async () => {
  const address = deriveP2TRWalletAddress(walletID, BitcoinNetwork.Testnet)
  const requestedPaths: string[] = []
  let depositRequestReads = 0
  const source = new EsploraP2TRSignatureFraudTransactionSource(
    "https://esplora.test",
    BitcoinNetwork.Testnet,
    [walletID],
    {
      taprootDepositRevealSource: {
        async getTaprootDepositRevealedEvents() {
          return [taprootDepositEvent()] as never[]
        },
        async taprootDepositOutputKeyCommitment() {
          return Hex.from("00".repeat(32))
        },
        async deposits() {
          depositRequestReads++
          throw new Error("unexpected deposit request read")
        },
      },
      onDepositScanFailure: ignoreDepositScanFailure,
      fetchFn: fakeFetch(
        {
          [addressMempoolPath(address)]: [],
        },
        requestedPaths
      ),
    }
  )

  assert.deepEqual(await source.listMempoolTransactions(), [])
  assert.equal(depositRequestReads, 0)
  assert.equal(
    requestedPaths.includes(depositOutspendPath(fundingTxid, 2)),
    false
  )
})

test("rejects a partial transaction view when a revealed outpoint is unavailable", async () => {
  const address = deriveP2TRWalletAddress(walletID, BitcoinNetwork.Testnet)
  const failures: P2TRDepositScanFailure[] = []
  const source = new EsploraP2TRSignatureFraudTransactionSource(
    "https://esplora.test",
    BitcoinNetwork.Testnet,
    [walletID],
    {
      taprootDepositRevealSource: taprootDepositRevealSource([
        taprootDepositEvent(),
      ]),
      onDepositScanFailure: (failure) => {
        failures.push(failure)
        throw new Error("failure reporter unavailable")
      },
      fetchFn: fakeFetch({
        [addressMempoolPath(address)]: [{ txid: mempoolTxid }],
        [`/tx/${mempoolTxid}/hex`]: rawMempoolTx,
      }),
    }
  )

  await assert.rejects(
    source.listMempoolTransactions(),
    /Incomplete P2TR transaction view/
  )
  assert.deepEqual(failures, [
    {
      stage: "outspend",
      fundingTxid,
      fundingOutputIndex: 2,
      error: `Failed to fetch Taproot deposit outspend ${fundingTxid}:2: not found`,
    },
  ])
})

test("contains rejected async deposit scan failure handlers", async () => {
  const address = deriveP2TRWalletAddress(walletID, BitcoinNetwork.Testnet)
  const failures: P2TRDepositScanFailure[] = []
  const source = new EsploraP2TRSignatureFraudTransactionSource(
    "https://esplora.test",
    BitcoinNetwork.Testnet,
    [walletID],
    {
      taprootDepositRevealSource: taprootDepositRevealSource([
        taprootDepositEvent(),
      ]),
      onDepositScanFailure: async (failure) => {
        failures.push(failure)
        throw new Error("async failure reporter unavailable")
      },
      fetchFn: fakeFetch({
        [addressMempoolPath(address)]: [{ txid: mempoolTxid }],
        [`/tx/${mempoolTxid}/hex`]: rawMempoolTx,
      }),
    }
  )

  await assert.rejects(
    source.listMempoolTransactions(),
    /Incomplete P2TR transaction view/
  )
  await new Promise<void>((resolve) => setImmediate(resolve))

  assert.deepEqual(failures, [
    {
      stage: "outspend",
      fundingTxid,
      fundingOutputIndex: 2,
      error: `Failed to fetch Taproot deposit outspend ${fundingTxid}:2: not found`,
    },
  ])
})

test("rejects a partial mempool view when a raw transaction is unavailable", async () => {
  const address = deriveP2TRWalletAddress(walletID, BitcoinNetwork.Testnet)
  const failures: P2TRDepositScanFailure[] = []
  const source = new EsploraP2TRSignatureFraudTransactionSource(
    "https://esplora.test",
    BitcoinNetwork.Testnet,
    [walletID],
    {
      taprootDepositRevealSource: taprootDepositRevealSource([
        taprootDepositEvent(),
      ]),
      onDepositScanFailure: (failure) => {
        failures.push(failure)
        throw new Error("failure reporter unavailable")
      },
      fetchFn: fakeFetch({
        [addressMempoolPath(address)]: [{ txid: mempoolTxid }],
        [depositOutspendPath(fundingTxid, 2)]: {
          spent: true,
          txid: secondMempoolTxid,
          status: { confirmed: false },
        },
        [`/tx/${mempoolTxid}/hex`]: rawMempoolTx,
      }),
    }
  )

  await assert.rejects(
    source.listMempoolTransactions(),
    /Incomplete P2TR transaction view/
  )
  assert.deepEqual(failures, [
    {
      stage: "raw-transaction",
      spendingTxid: secondMempoolTxid,
      fundingTxid,
      fundingOutputIndex: 2,
      error: `Failed to fetch raw Bitcoin transaction ${secondMempoolTxid}: not found`,
    },
  ])
})

test("rejects a partial confirmed view when a raw transaction is unavailable", async () => {
  const address = deriveP2TRWalletAddress(walletID, BitcoinNetwork.Testnet)
  const failures: P2TRDepositScanFailure[] = []
  const source = new EsploraP2TRSignatureFraudTransactionSource(
    "https://esplora.test",
    BitcoinNetwork.Testnet,
    [walletID],
    {
      taprootDepositRevealSource: taprootDepositRevealSource([
        taprootDepositEvent(),
      ]),
      onDepositScanFailure: (failure) => failures.push(failure),
      fetchFn: fakeFetch({
        [addressConfirmedPath(address)]: [
          confirmedSummary(confirmedTxid, blockHash, 123),
        ],
        [`${addressConfirmedPath(address)}/${confirmedTxid}`]: [],
        [depositOutspendPath(fundingTxid, 2)]: {
          spent: true,
          txid: nextConfirmedTxid,
          status: {
            confirmed: true,
            block_hash: blockHash,
            block_height: 124,
          },
        },
        [`/tx/${confirmedTxid}/hex`]: rawConfirmedTx,
      }),
    }
  )

  await assert.rejects(
    source.listConfirmedTransactions(),
    /Incomplete P2TR transaction view/
  )
  assert.deepEqual(failures, [
    {
      stage: "raw-transaction",
      spendingTxid: nextConfirmedTxid,
      fundingTxid,
      fundingOutputIndex: 2,
      error: `Failed to fetch raw Bitcoin transaction ${nextConfirmedTxid}: not found`,
    },
  ])
})

test("reports every deposit binding when a shared raw transaction is unavailable", async () => {
  const address = deriveP2TRWalletAddress(walletID, BitcoinNetwork.Testnet)
  const secondFundingTxid = "13".repeat(32)
  const requestedPaths: string[] = []
  const failures: P2TRDepositScanFailure[] = []
  const source = new EsploraP2TRSignatureFraudTransactionSource(
    "https://esplora.test",
    BitcoinNetwork.Testnet,
    [walletID],
    {
      taprootDepositRevealSource: taprootDepositRevealSource([
        taprootDepositEvent(),
        taprootDepositEvent({
          fundingTxHash: BitcoinTxHash.from(secondFundingTxid),
          fundingOutputIndex: 3,
        }),
      ]),
      onDepositScanFailure: (failure) => failures.push(failure),
      fetchFn: fakeFetch(
        {
          [addressMempoolPath(address)]: [{ txid: mempoolTxid }],
          [depositOutspendPath(fundingTxid, 2)]: {
            spent: true,
            txid: secondMempoolTxid,
            status: { confirmed: false },
          },
          [depositOutspendPath(secondFundingTxid, 3)]: {
            spent: true,
            txid: secondMempoolTxid,
            status: { confirmed: false },
          },
          [`/tx/${mempoolTxid}/hex`]: rawMempoolTx,
        },
        requestedPaths
      ),
    }
  )

  await assert.rejects(
    source.listMempoolTransactions(),
    /Incomplete P2TR transaction view/
  )
  assert.equal(
    requestedPaths.filter((path) => path === `/tx/${secondMempoolTxid}/hex`)
      .length,
    1
  )
  assert.deepEqual(
    failures.map(({ fundingTxid, fundingOutputIndex }) => ({
      fundingTxid,
      fundingOutputIndex,
    })),
    [
      { fundingTxid, fundingOutputIndex: 2 },
      { fundingTxid: secondFundingTxid, fundingOutputIndex: 3 },
    ]
  )
  failures.forEach((failure) => {
    assert.equal(failure.stage, "raw-transaction")
    assert.equal(failure.spendingTxid, secondMempoolTxid)
  })
})

test("rejects raw transaction failures for wallet-only candidates", async () => {
  const address = deriveP2TRWalletAddress(walletID, BitcoinNetwork.Testnet)
  const failures: P2TRDepositScanFailure[] = []
  const source = new EsploraP2TRSignatureFraudTransactionSource(
    "https://esplora.test",
    BitcoinNetwork.Testnet,
    [walletID],
    {
      taprootDepositRevealSource: emptyTaprootDepositRevealSource,
      onDepositScanFailure: (failure) => failures.push(failure),
      fetchFn: fakeFetch({
        [addressMempoolPath(address)]: [
          { txid: mempoolTxid },
          { txid: secondMempoolTxid },
        ],
        [`/tx/${mempoolTxid}/hex`]: rawMempoolTx,
      }),
    }
  )

  await assert.rejects(
    source.listMempoolTransactions(),
    /Incomplete P2TR transaction view/
  )
  assert.deepEqual(failures, [
    {
      stage: "raw-transaction",
      spendingTxid: secondMempoolTxid,
      error: `Failed to fetch raw Bitcoin transaction ${secondMempoolTxid}: not found`,
    },
  ])
})

test("rejects a failed deposit request after scanning honest siblings", async () => {
  const address = deriveP2TRWalletAddress(walletID, BitcoinNetwork.Testnet)
  const secondFundingTxid = "13".repeat(32)
  const firstEvent = taprootDepositEvent()
  const secondEvent = taprootDepositEvent({
    fundingTxHash: BitcoinTxHash.from(secondFundingTxid),
    fundingOutputIndex: 3,
  })
  const failures: P2TRDepositScanFailure[] = []
  const revealSource: P2TRTaprootDepositRevealSource = {
    async getTaprootDepositRevealedEvents() {
      return [firstEvent, secondEvent] as never[]
    },
    async deposits(txid) {
      if (txid.toString() === fundingTxid) {
        throw new Error("deposit RPC unavailable")
      }
      return {
        depositor: { identifierHex: "23".repeat(20) },
        revealedAt: 1,
        treasuryFee: { toString: () => "0" },
      } as never
    },
    async taprootDepositOutputKeyCommitment() {
      return Hex.from("01".repeat(32))
    },
  }
  const source = new EsploraP2TRSignatureFraudTransactionSource(
    "https://esplora.test",
    BitcoinNetwork.Testnet,
    [walletID],
    {
      taprootDepositRevealSource: revealSource,
      onDepositScanFailure: (failure) => failures.push(failure),
      fetchFn: fakeFetch({
        [addressMempoolPath(address)]: [],
        [depositOutspendPath(secondFundingTxid, 3)]: {
          spent: true,
          txid: mempoolTxid,
          status: { confirmed: false },
        },
        [`/tx/${mempoolTxid}/hex`]: rawMempoolTx,
      }),
    }
  )

  await assert.rejects(
    source.listMempoolTransactions(),
    /Incomplete P2TR transaction view/
  )
  assert.deepEqual(failures, [
    {
      stage: "deposit-request",
      fundingTxid,
      fundingOutputIndex: 2,
      error: "deposit RPC unavailable",
    },
  ])
})

test("rejects a failed deposit commitment read", async () => {
  const address = deriveP2TRWalletAddress(walletID, BitcoinNetwork.Testnet)
  const failures: P2TRDepositScanFailure[] = []
  const source = new EsploraP2TRSignatureFraudTransactionSource(
    "https://esplora.test",
    BitcoinNetwork.Testnet,
    [walletID],
    {
      taprootDepositRevealSource: {
        async getTaprootDepositRevealedEvents() {
          return [taprootDepositEvent()] as never[]
        },
        async taprootDepositOutputKeyCommitment() {
          throw new Error("commitment RPC unavailable")
        },
        async deposits() {
          throw new Error("unexpected deposit request read")
        },
      },
      onDepositScanFailure: (failure) => failures.push(failure),
      fetchFn: fakeFetch({
        [addressMempoolPath(address)]: [{ txid: mempoolTxid }],
        [`/tx/${mempoolTxid}/hex`]: rawMempoolTx,
      }),
    }
  )

  await assert.rejects(
    source.listMempoolTransactions(),
    /Incomplete P2TR transaction view/
  )
  assert.deepEqual(failures, [
    {
      stage: "deposit-request",
      fundingTxid,
      fundingOutputIndex: 2,
      error: "commitment RPC unavailable",
    },
  ])
})

test("rejects a fulfilled reveal-history omission against the independent source", async () => {
  const address = deriveP2TRWalletAddress(walletID, BitcoinNetwork.Testnet)
  const requestedPaths: string[] = []
  const failures: P2TRDepositScanFailure[] = []
  const canonicalSource = independentTaprootDepositRevealSource(
    taprootDepositRevealSource([taprootDepositEvent()])
  )
  const primarySource = {
    ...taprootDepositRevealSource([]),
    async getBlockNumber() {
      return 13
    },
    getCanonicalBlockHash: (blockNumber: number) =>
      canonicalSource.getCanonicalBlockHash(blockNumber),
  }
  const source = new VerifiedEsploraP2TRSignatureFraudTransactionSource(
    "https://esplora.test",
    BitcoinNetwork.Testnet,
    [walletID],
    {
      taprootDepositRevealSource: primarySource,
      taprootDepositRevealSourceTrustDomainID: "indexer.test",
      canonicalTaprootDepositRevealSource: canonicalSource,
      confirmedHistoryCursorStore: new MemoryConfirmedHistoryCursorStore(),
      taprootDepositRevealChainID: "31337",
      taprootDepositRevealBridgeAddress: `0x${"11".repeat(20)}`,
      onDepositScanFailure: (failure) => failures.push(failure),
      fetchFn: fakeFetch({ [addressMempoolPath(address)]: [] }, requestedPaths),
    }
  )

  await assert.rejects(
    source.listMempoolTransactions(),
    /reveal history is incomplete/
  )
  assert.deepEqual(failures, [
    {
      stage: "reveal-history",
      error: "Taproot deposit reveal range is not independently complete",
    },
  ])
  assert.equal(
    requestedPaths.some((path) => path.includes("/outspend/")),
    false
  )
})

test("deduplicates wallet and duplicate reveal discoveries while preserving bindings", async () => {
  const address = deriveP2TRWalletAddress(walletID, BitcoinNetwork.Testnet)
  const requestedPaths: string[] = []
  const event = taprootDepositEvent()
  const source = new EsploraP2TRSignatureFraudTransactionSource(
    "https://esplora.test",
    BitcoinNetwork.Testnet,
    [walletID],
    {
      taprootDepositRevealSource: taprootDepositRevealSource([event, event]),
      onDepositScanFailure: ignoreDepositScanFailure,
      fetchFn: fakeFetch(
        {
          [addressMempoolPath(address)]: [{ txid: mempoolTxid }],
          [depositOutspendPath(fundingTxid, 2)]: {
            spent: true,
            txid: mempoolTxid,
            status: { confirmed: false },
          },
          [`/tx/${mempoolTxid}/hex`]: rawMempoolTx,
        },
        requestedPaths
      ),
    }
  )

  const transactions = await source.listMempoolTransactions()

  assert.equal(transactions.length, 1)
  assert.equal(transactions[0].walletInputKeyBindings?.length, 1)
  assert.equal(
    requestedPaths.filter(
      (path) => path === depositOutspendPath(fundingTxid, 2)
    ).length,
    1
  )
  assert.equal(
    requestedPaths.filter((path) => path === `/tx/${mempoolTxid}/hex`).length,
    1
  )
})

test("rejects the transaction view when reveal-history retrieval fails", async () => {
  const address = deriveP2TRWalletAddress(walletID, BitcoinNetwork.Testnet)
  const failures: P2TRDepositScanFailure[] = []
  const source = new EsploraP2TRSignatureFraudTransactionSource(
    "https://esplora.test",
    BitcoinNetwork.Testnet,
    [walletID],
    {
      taprootDepositRevealSource: {
        async getTaprootDepositRevealedEvents() {
          throw new Error("Bridge RPC unavailable")
        },
        async taprootDepositOutputKeyCommitment() {
          throw new Error("unexpected commitment read")
        },
        async deposits() {
          throw new Error("unexpected deposit read")
        },
      },
      onDepositScanFailure: (failure) => failures.push(failure),
      fetchFn: fakeFetch({
        [addressMempoolPath(address)]: [{ txid: mempoolTxid }],
        [`/tx/${mempoolTxid}/hex`]: rawMempoolTx,
      }),
    }
  )

  await assert.rejects(
    source.listMempoolTransactions(),
    /Incomplete P2TR transaction view/
  )
  assert.deepEqual(failures, [
    { stage: "reveal-history", error: "Bridge RPC unavailable" },
  ])
})

test("wires domainless Esplora observation config with its reveal-chain domain", async () => {
  const address = deriveP2TRWalletAddress(walletID, BitcoinNetwork.Testnet)
  const config = loadP2TRSignatureFraudWatchtowerRuntimeConfig({
    [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.stateFilePath]:
      "/var/lib/tbtc/p2tr-watchtower.json",
    [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.walletIDs]: walletID,
    [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.esploraBaseUrl]:
      "https://esplora.test/",
    [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.esploraBitcoinNetwork]: "testnet",
    [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.esploraMaxAttempts]: "2",
    [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.esploraRequestTimeoutMs]: "1000",
    [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.esploraRetryDelayMs]: "0",
    [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.esploraConfirmedPageLimit]: "1",
    [P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV.esploraConfirmedHistoryCursorFilePath]:
      "/var/lib/tbtc/p2tr-confirmed-history.json",
  })
  const source = createEsploraP2TRTransactionSourceFromRuntimeConfig(config, {
    taprootDepositRevealChainID: "31337",
    taprootDepositRevealBridgeAddress: `0x${"11".repeat(20)}`,
    taprootDepositRevealSource: emptyTaprootDepositRevealSource,
    taprootDepositRevealSourceTrustDomainID: "indexer.test",
    canonicalTaprootDepositRevealSource: independentTaprootDepositRevealSource(
      emptyTaprootDepositRevealSource
    ),
    confirmedHistoryCursorStore: new MemoryConfirmedHistoryCursorStore(),
    onDepositScanFailure: ignoreDepositScanFailure,
    fetchFn: fakeFetch({
      [addressMempoolPath(address)]: [{ txid: mempoolTxid }],
      [`/tx/${mempoolTxid}/hex`]: rawMempoolTx,
    }),
  })

  const transactions = await source.listMempoolTransactions()

  assert.deepEqual(
    transactions.map((transaction) => transaction.bitcoinTxHash.toString()),
    [mempoolTxid]
  )
})

test("lists paged Esplora confirmed P2TR wallet transactions with block metadata", async () => {
  const address = deriveP2TRWalletAddress(walletID, BitcoinNetwork.Testnet)
  const requestedPaths: string[] = []
  const source = new EsploraP2TRSignatureFraudTransactionSource(
    "https://esplora.test",
    BitcoinNetwork.Testnet,
    [walletID],
    {
      taprootDepositRevealSource: emptyTaprootDepositRevealSource,
      onDepositScanFailure: ignoreDepositScanFailure,
      confirmedPageLimit: 2,
      fetchFn: fakeFetch(
        {
          [addressConfirmedPath(address)]: [
            confirmedSummary(confirmedTxid, blockHash, 123),
          ],
          [`${addressConfirmedPath(address)}/${confirmedTxid}`]: [
            confirmedSummary(nextConfirmedTxid, blockHash, 124),
          ],
          [`${addressConfirmedPath(address)}/${nextConfirmedTxid}`]: [],
          [`/tx/${confirmedTxid}/hex`]: rawConfirmedTx,
          [`/tx/${nextConfirmedTxid}/hex`]: rawConfirmedTx,
        },
        requestedPaths
      ),
    }
  )

  const result = await source.listConfirmedTransactions()
  const { transactions } = result

  // Bounded pagination can finish, but Esplora is not an independently
  // authenticated canonical Bitcoin feed and never certifies lifecycle safety.
  assert.equal(result.complete, false)

  assert.deepEqual(
    transactions.map((transaction) => transaction.bitcoinTxHash.toString()),
    [confirmedTxid, nextConfirmedTxid]
  )
  assert.deepEqual(
    transactions.map((transaction) => transaction.bitcoinBlockHash),
    [blockHash, blockHash]
  )
  assert.deepEqual(
    transactions.map((transaction) => transaction.bitcoinBlockHeight),
    [123, 124]
  )
  assert.ok(
    requestedPaths.includes(
      `${addressConfirmedPath(address)}/${nextConfirmedTxid}`
    )
  )
})

test("resumes a 26-transaction confirmed history across source restarts", async () => {
  const address = deriveP2TRWalletAddress(walletID, BitcoinNetwork.Testnet)
  const pageOneTxids = Array.from({ length: 25 }, (_, index) =>
    (index + 1).toString(16).padStart(2, "0").repeat(32)
  )
  const pageTwoTxid = "f1".repeat(32)
  const requestedPaths: string[] = []
  const cursorStore = new MemoryConfirmedHistoryCursorStore()
  const routes: Record<string, FakeRoute["body"] | FakeRoute> = {
    [addressConfirmedPath(address)]: pageOneTxids.map((txid, index) =>
      confirmedSummary(txid, blockHash, 100 + index)
    ),
    [`${addressConfirmedPath(address)}/${pageOneTxids[24]}`]: [
      confirmedSummary(pageTwoTxid, blockHash, 125),
    ],
    [`${addressConfirmedPath(address)}/${pageTwoTxid}`]: [],
  }
  for (const txid of [...pageOneTxids, pageTwoTxid]) {
    routes[`/tx/${txid}/hex`] = rawConfirmedTx
  }
  routes[`/tx/${pageOneTxids[0]}/status`] = confirmedSummary(
    pageOneTxids[0],
    blockHash,
    100
  ).status
  routes[`/tx/${pageOneTxids[24]}/status`] = confirmedSummary(
    pageOneTxids[24],
    blockHash,
    124
  ).status
  const buildSource = () =>
    new EsploraP2TRSignatureFraudTransactionSource(
      "https://esplora.test",
      BitcoinNetwork.Testnet,
      [walletID],
      {
        taprootDepositRevealSource: emptyTaprootDepositRevealSource,
        onDepositScanFailure: ignoreDepositScanFailure,
        confirmedPageLimit: 1,
        confirmedHistoryCursorStore: cursorStore,
        fetchFn: fakeFetch(routes, requestedPaths),
      }
    )

  const firstSource = buildSource()
  const firstBatch = await firstSource.listConfirmedTransactions()
  assert.equal(firstBatch.complete, false)
  assert.equal(firstBatch.transactions.length, 25)
  await firstSource.commitConfirmedTransactionScan()

  const secondSource = buildSource()
  const secondBatch = await secondSource.listConfirmedTransactions()
  assert.equal(secondBatch.complete, false)
  assert.equal(secondBatch.transactions.length, 1)
  assert.equal(
    secondBatch.transactions[0].bitcoinTxHash.toString(),
    pageTwoTxid
  )
  await secondSource.commitConfirmedTransactionScan()
  assert.ok(
    requestedPaths.includes(
      `${addressConfirmedPath(address)}/${pageOneTxids[24]}`
    )
  )
  assert.ok(requestedPaths.includes(`/tx/${pageTwoTxid}/hex`))
})

test("bounds and resumes 25, 50, and 51 confirmed transactions", async () => {
  const expectedCycles = new Map([
    [25, 1],
    [50, 2],
    [51, 3],
  ])

  for (const [historyCount, cycleCount] of expectedCycles) {
    const address = deriveP2TRWalletAddress(walletID, BitcoinNetwork.Testnet)
    const txids = Array.from({ length: historyCount }, (_, index) =>
      (index + 1).toString(16).padStart(64, "0")
    )
    const routes: Record<string, FakeRoute["body"] | FakeRoute> = {}
    for (let offset = 0; offset < txids.length; offset += 25) {
      const pageTxids = txids.slice(offset, offset + 25)
      const path =
        offset === 0
          ? addressConfirmedPath(address)
          : `${addressConfirmedPath(address)}/${txids[offset - 1]}`
      routes[path] = pageTxids.map((txid, index) =>
        confirmedSummary(txid, blockHash, 100 + offset + index)
      )
    }
    routes[`${addressConfirmedPath(address)}/${txids[txids.length - 1]}`] = []
    txids.forEach((txid) => {
      routes[`/tx/${txid}/hex`] = rawConfirmedTx
    })
    for (const index of [0, 24, 49]) {
      const txid = txids[index]
      if (txid === undefined) continue
      routes[`/tx/${txid}/status`] = confirmedSummary(
        txid,
        blockHash,
        100 + index
      ).status
    }

    const cursorStore = new MemoryConfirmedHistoryCursorStore()
    const buildSource = () =>
      new EsploraP2TRSignatureFraudTransactionSource(
        "https://esplora.test",
        BitcoinNetwork.Testnet,
        [walletID],
        {
          taprootDepositRevealSource: emptyTaprootDepositRevealSource,
          onDepositScanFailure: ignoreDepositScanFailure,
          confirmedPageLimit: 1,
          confirmedHistoryCursorStore: cursorStore,
          fetchFn: fakeFetch(routes),
        }
      )

    let observed = 0
    for (let cycle = 1; cycle <= cycleCount; cycle++) {
      const source = buildSource()
      const batch = await source.listConfirmedTransactions()
      observed += batch.transactions.length
      assert.equal(batch.complete, false)
      await source.commitConfirmedTransactionScan()
    }
    assert.equal(observed, historyCount)
  }
})

test("advances each wallet history independently during bounded catch-up", async () => {
  const firstAddress = deriveP2TRWalletAddress(walletID, BitcoinNetwork.Testnet)
  const secondAddress = deriveP2TRWalletAddress(
    secondWalletID,
    BitcoinNetwork.Testnet
  )
  const firstTxids = Array.from({ length: 26 }, (_, index) =>
    (0x100 + index).toString(16).padStart(64, "0")
  )
  const secondTxids = Array.from({ length: 25 }, (_, index) =>
    (0x200 + index).toString(16).padStart(64, "0")
  )
  const secondTerminalPath = `${addressConfirmedPath(secondAddress)}/${
    secondTxids[24]
  }`
  const requestedPaths: string[] = []
  const routes: Record<string, FakeRoute["body"] | FakeRoute> = {
    [addressConfirmedPath(firstAddress)]: firstTxids
      .slice(0, 25)
      .map((txid, index) => confirmedSummary(txid, blockHash, 300 + index)),
    [`${addressConfirmedPath(firstAddress)}/${firstTxids[24]}`]: [
      confirmedSummary(firstTxids[25], blockHash, 325),
    ],
    [`${addressConfirmedPath(firstAddress)}/${firstTxids[25]}`]: [],
    [addressConfirmedPath(secondAddress)]: secondTxids.map((txid, index) =>
      confirmedSummary(txid, blockHash, 400 + index)
    ),
    [secondTerminalPath]: [],
  }
  for (const txid of [...firstTxids, ...secondTxids]) {
    routes[`/tx/${txid}/hex`] = rawConfirmedTx
  }
  routes[`/tx/${firstTxids[0]}/status`] = confirmedSummary(
    firstTxids[0],
    blockHash,
    300
  ).status
  routes[`/tx/${firstTxids[24]}/status`] = confirmedSummary(
    firstTxids[24],
    blockHash,
    324
  ).status
  const cursorStore = new MemoryConfirmedHistoryCursorStore()
  const source = new EsploraP2TRSignatureFraudTransactionSource(
    "https://esplora.test",
    BitcoinNetwork.Testnet,
    [walletID, secondWalletID],
    {
      taprootDepositRevealSource: emptyTaprootDepositRevealSource,
      onDepositScanFailure: ignoreDepositScanFailure,
      confirmedHistoryCursorStore: cursorStore,
      fetchFn: fakeFetch(routes, requestedPaths),
    }
  )

  const firstBatch = await source.listConfirmedTransactions()
  assert.equal(firstBatch.complete, false)
  assert.equal(firstBatch.transactions.length, 50)
  await source.commitConfirmedTransactionScan()
  assert.equal(
    requestedPaths.filter((path) => path === secondTerminalPath).length,
    1
  )

  const secondBatch = await source.listConfirmedTransactions()
  assert.equal(secondBatch.complete, false)
  assert.equal(secondBatch.transactions.length, 1)
  await source.commitConfirmedTransactionScan()
  assert.equal(
    requestedPaths.filter((path) => path === secondTerminalPath).length,
    1
  )
})

test("rebuilds confirmed history when the stored anchor is reorganized", async () => {
  const address = deriveP2TRWalletAddress(walletID, BitcoinNetwork.Testnet)
  const firstTxid = "71".repeat(32)
  const removedTxid = "72".repeat(32)
  const replacementTxid = "73".repeat(32)
  const replacementBlockHash = "74".repeat(32)
  const routes: Record<string, FakeRoute["body"] | FakeRoute> = {
    [addressConfirmedPath(address)]: [
      confirmedSummary(firstTxid, blockHash, 200),
      confirmedSummary(removedTxid, blockHash, 199),
    ],
    [`${addressConfirmedPath(address)}/${removedTxid}`]: [],
    [`/tx/${firstTxid}/hex`]: rawConfirmedTx,
    [`/tx/${removedTxid}/hex`]: rawConfirmedTx,
    [`/tx/${replacementTxid}/hex`]: rawConfirmedTx,
  }
  const cursorStore = new MemoryConfirmedHistoryCursorStore()
  const source = new EsploraP2TRSignatureFraudTransactionSource(
    "https://esplora.test",
    BitcoinNetwork.Testnet,
    [walletID],
    {
      taprootDepositRevealSource: emptyTaprootDepositRevealSource,
      onDepositScanFailure: ignoreDepositScanFailure,
      confirmedHistoryCursorStore: cursorStore,
      fetchFn: fakeFetch(routes),
    }
  )

  assert.deepEqual(
    (await source.listConfirmedTransactions()).transactions.map(
      ({ bitcoinTxHash }) => bitcoinTxHash.toString()
    ),
    [firstTxid, removedTxid]
  )
  await source.commitConfirmedTransactionScan()

  routes[addressConfirmedPath(address)] = [
    confirmedSummary(firstTxid, replacementBlockHash, 201),
    confirmedSummary(replacementTxid, replacementBlockHash, 200),
  ]
  routes[`${addressConfirmedPath(address)}/${replacementTxid}`] = []

  const reorganized = (await source.listConfirmedTransactions()).transactions
  assert.deepEqual(
    reorganized.map(({ bitcoinTxHash }) => bitcoinTxHash.toString()),
    [firstTxid, replacementTxid]
  )
  assert.equal(reorganized[0].bitcoinBlockHash, replacementBlockHash)
})

test("discovers confirmed spends of revealed Taproot deposit outpoints", async () => {
  const address = deriveP2TRWalletAddress(walletID, BitcoinNetwork.Testnet)
  const source = new EsploraP2TRSignatureFraudTransactionSource(
    "https://esplora.test",
    BitcoinNetwork.Testnet,
    [walletID],
    {
      taprootDepositRevealSource: taprootDepositRevealSource([
        taprootDepositEvent(),
      ]),
      onDepositScanFailure: ignoreDepositScanFailure,
      fetchFn: fakeFetch({
        [addressConfirmedPath(address)]: [],
        [depositOutspendPath(fundingTxid, 2)]: {
          spent: true,
          txid: confirmedTxid,
          status: {
            confirmed: true,
            block_hash: blockHash,
            block_height: 123,
          },
        },
        [`/tx/${confirmedTxid}/hex`]: rawConfirmedTx,
      }),
    }
  )

  const result = await source.listConfirmedTransactions()
  const { transactions } = result

  assert.equal(result.complete, false)
  assert.equal(transactions.length, 1)
  assert.equal(transactions[0].bitcoinTxHash.toString(), confirmedTxid)
  assert.equal(transactions[0].bitcoinBlockHash, blockHash)
  assert.equal(transactions[0].bitcoinBlockHeight, 123)
  assert.deepEqual(
    transactions[0].walletInputKeyBindings?.map(({ txid, vout, walletID }) => ({
      txid: String(txid),
      vout,
      walletID: String(walletID),
    })),
    [{ txid: fundingTxid, vout: 2, walletID: walletID.slice(2) }]
  )
})

test("rejects confirmed Esplora transactions without block metadata", async () => {
  const address = deriveP2TRWalletAddress(walletID, BitcoinNetwork.Testnet)
  const source = new EsploraP2TRSignatureFraudTransactionSource(
    "https://esplora.test",
    BitcoinNetwork.Testnet,
    [walletID],
    {
      taprootDepositRevealSource: emptyTaprootDepositRevealSource,
      onDepositScanFailure: ignoreDepositScanFailure,
      fetchFn: fakeFetch({
        [addressConfirmedPath(address)]: [
          {
            txid: confirmedTxid,
            status: { confirmed: true },
          },
        ],
        [`${addressConfirmedPath(address)}/${confirmedTxid}`]: [],
      }),
    }
  )

  await assert.rejects(
    source.listConfirmedTransactions(),
    /missing Esplora block metadata/
  )
})

test("validates Esplora source configuration before scanning", () => {
  assert.throws(
    () =>
      new EsploraP2TRSignatureFraudTransactionSource(
        "",
        BitcoinNetwork.Testnet,
        [walletID],
        {
          taprootDepositRevealSource: emptyTaprootDepositRevealSource,
          onDepositScanFailure: ignoreDepositScanFailure,
        }
      ),
    /base URL is required/
  )
  assert.throws(
    () =>
      new EsploraP2TRSignatureFraudTransactionSource(
        "esplora.test",
        BitcoinNetwork.Testnet,
        [walletID],
        {
          taprootDepositRevealSource: emptyTaprootDepositRevealSource,
          onDepositScanFailure: ignoreDepositScanFailure,
        }
      ),
    /base URL must be an absolute http\(s\) URL/
  )
  assert.throws(
    () =>
      new EsploraP2TRSignatureFraudTransactionSource(
        "file:///tmp/esplora",
        BitcoinNetwork.Testnet,
        [walletID],
        {
          taprootDepositRevealSource: emptyTaprootDepositRevealSource,
          onDepositScanFailure: ignoreDepositScanFailure,
        }
      ),
    /base URL must be an absolute http\(s\) URL/
  )
  assert.throws(
    () =>
      new EsploraP2TRSignatureFraudTransactionSource(
        "https://esplora.test",
        BitcoinNetwork.Testnet,
        [],
        {
          taprootDepositRevealSource: emptyTaprootDepositRevealSource,
          onDepositScanFailure: ignoreDepositScanFailure,
        }
      ),
    /requires wallet IDs/
  )
  assert.throws(
    () =>
      new EsploraP2TRSignatureFraudTransactionSource(
        "https://esplora.test",
        BitcoinNetwork.Testnet,
        ["0x1234"],
        {
          taprootDepositRevealSource: emptyTaprootDepositRevealSource,
          onDepositScanFailure: ignoreDepositScanFailure,
        }
      ),
    /wallet ID must be 32 bytes/
  )
  assert.throws(
    () =>
      new EsploraP2TRSignatureFraudTransactionSource(
        "https://esplora.test",
        BitcoinNetwork.Testnet,
        [walletID],
        undefined as never
      ),
    /requires a Taproot deposit reveal source/
  )
  assert.throws(
    () =>
      new EsploraP2TRSignatureFraudTransactionSource(
        "https://esplora.test",
        BitcoinNetwork.Testnet,
        [walletID],
        {
          taprootDepositRevealSource: {
            async getTaprootDepositRevealedEvents() {
              return []
            },
            async deposits() {
              throw new Error("unexpected deposit request read")
            },
          } as never,
          onDepositScanFailure: ignoreDepositScanFailure,
        }
      ),
    /requires a Taproot deposit reveal source/
  )
  assert.throws(
    () =>
      new EsploraP2TRSignatureFraudTransactionSource(
        "https://esplora.test",
        BitcoinNetwork.Testnet,
        [walletID],
        {
          taprootDepositRevealSource: emptyTaprootDepositRevealSource,
        } as never
      ),
    /requires a deposit scan failure handler/
  )
  for (const depositScanConcurrency of [0, 1.5]) {
    assert.throws(
      () =>
        new EsploraP2TRSignatureFraudTransactionSource(
          "https://esplora.test",
          BitcoinNetwork.Testnet,
          [walletID],
          {
            taprootDepositRevealSource: emptyTaprootDepositRevealSource,
            onDepositScanFailure: ignoreDepositScanFailure,
            depositScanConcurrency,
          }
        ),
      /depositScanConcurrency must be a positive integer/
    )
  }
})

function withRevealSourceVerification(
  source: TestEsploraOptions["taprootDepositRevealSource"]
): P2TRTaprootDepositRevealSource {
  return {
    ...source,
    providerIdentity: source.providerIdentity ?? {},
    getBlockNumber: source.getBlockNumber ?? (async () => 13),
    getCanonicalBlockHash:
      source.getCanonicalBlockHash ??
      (async (blockNumber) => blockNumber.toString(16).padStart(64, "0")),
  }
}

function taprootDepositRevealSource(
  events: unknown[],
  extraData?: Hex,
  outputKeyCommitment = Hex.from("01".repeat(32))
): P2TRTaprootDepositRevealSource {
  const confirmationDepth = 12
  const blockNumbers = events
    .map((event) =>
      typeof event === "object" && event !== null && "blockNumber" in event
        ? Number(event.blockNumber)
        : 0
    )
    .filter(Number.isSafeInteger)
  const head = Math.max(0, ...blockNumbers) + confirmationDepth

  return {
    providerIdentity: {},
    async getBlockNumber() {
      return head
    },
    async getCanonicalBlockHash(blockNumber) {
      const event = events.find(
        (candidate) =>
          typeof candidate === "object" &&
          candidate !== null &&
          "blockNumber" in candidate &&
          candidate.blockNumber === blockNumber &&
          "blockHash" in candidate
      ) as { blockHash?: { toString(): string } } | undefined
      return (
        event?.blockHash?.toString() ??
        blockNumber.toString(16).padStart(64, "0")
      )
    },
    async getTaprootDepositRevealedEvents(options) {
      return events.filter((event) => {
        if (
          typeof event !== "object" ||
          event === null ||
          !("blockNumber" in event)
        ) {
          return true
        }
        const eventBlock = Number(event.blockNumber)
        return (
          (options?.fromBlock === undefined ||
            eventBlock >= options.fromBlock) &&
          (options?.toBlock === undefined || eventBlock <= options.toBlock)
        )
      }) as never[]
    },
    async deposits() {
      return {
        depositor: { identifierHex: "23".repeat(20) },
        revealedAt: 1,
        treasuryFee: { toString: () => "0" },
        extraData,
      } as never
    },
    async taprootDepositOutputKeyCommitment() {
      return outputKeyCommitment
    },
  }
}

function independentTaprootDepositRevealSource(
  source: P2TRTaprootDepositRevealSource,
  trustDomainID = "canonical.test"
): P2TRCanonicalTaprootDepositRevealSource {
  return {
    trustDomainID,
    providerIdentity: {},
    getBlockNumber: () => source.getBlockNumber(),
    getCanonicalBlockHash: (blockNumber) =>
      source.getCanonicalBlockHash(blockNumber),
    getTaprootDepositRevealedEvents: (...args) =>
      source.getTaprootDepositRevealedEvents(...args),
    deposits: (...args) => source.deposits(...args),
    taprootDepositOutputKeyCommitment: (...args) =>
      source.taprootDepositOutputKeyCommitment(...args),
  }
}

function taprootDepositEvent(overrides: Record<string, unknown> = {}): unknown {
  return {
    blockNumber: 1,
    blockHash: Hex.from("21".repeat(32)),
    transactionHash: Hex.from("22".repeat(32)),
    fundingTxHash: BitcoinTxHash.from(fundingTxid),
    fundingOutputIndex: 2,
    depositor: { identifierHex: "23".repeat(20) },
    amount: { toString: () => "100000" },
    blindingFactor: Hex.from("24".repeat(8)),
    walletPublicKeyHash: Hex.from("25".repeat(20)),
    walletXOnlyPublicKey: Hex.from(walletID),
    refundPublicKeyHash: Hex.from("26".repeat(20)),
    refundXOnlyPublicKey: Hex.from(secondWalletID),
    refundLocktime: Hex.from("00000000"),
    ...overrides,
  }
}

function confirmedSummary(
  txid: string,
  blockHashHex: string,
  blockHeight: number
) {
  return {
    txid,
    status: {
      confirmed: true,
      block_hash: blockHashHex,
      block_height: blockHeight,
    },
  }
}

function addressMempoolPath(address: string): string {
  return `/address/${encodeURIComponent(address)}/txs/mempool`
}

function addressConfirmedPath(address: string): string {
  return `/address/${encodeURIComponent(address)}/txs/chain`
}

function depositOutspendPath(txid: string, vout: number): string {
  return `/tx/${txid}/outspend/${vout}`
}

function fakeFetch(
  routes: Record<string, FakeRoute["body"] | FakeRoute>,
  requestedPaths: string[] = []
): P2TREsploraFetch {
  return async (input) => {
    const path = new URL(input).pathname
    requestedPaths.push(path)

    const route = routes[path]
    if (route === undefined) {
      return new Response("not found", { status: 404 })
    }

    const normalizedRoute = isFakeRoute(route)
      ? route
      : { status: 200, body: route }
    const body =
      typeof normalizedRoute.body === "string"
        ? normalizedRoute.body
        : JSON.stringify(normalizedRoute.body)

    return new Response(body, { status: normalizedRoute.status ?? 200 })
  }
}

function isFakeRoute(value: FakeRoute["body"] | FakeRoute): value is FakeRoute {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "body" in value
  )
}

function createConcurrencyProbe() {
  let inFlight = 0
  let maxInFlight = 0
  let started = 0

  return {
    get maxInFlight() {
      return maxInFlight
    },
    get started() {
      return started
    },
    async track<T>(operation: () => T | Promise<T>): Promise<T> {
      started++
      inFlight++
      maxInFlight = Math.max(maxInFlight, inFlight)
      await new Promise<void>((resolve) => setImmediate(resolve))
      try {
        return await operation()
      } finally {
        inFlight--
      }
    },
  }
}
