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
  EsploraP2TRSignatureFraudTransactionSource,
  P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV,
  P2TREsploraFetch,
  P2TRTaprootDepositRevealSource,
  createEsploraP2TRTransactionSourceFromRuntimeConfig,
  deriveP2TRWalletAddress,
  loadP2TRSignatureFraudWatchtowerRuntimeConfig,
} from "../src/index.js"
import type { P2TRDepositScanFailure } from "../src/index.js"

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

test("keeps wallet transactions when a revealed outpoint is unavailable", async () => {
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

  const transactions = await source.listMempoolTransactions()

  assert.deepEqual(
    transactions.map(({ bitcoinTxHash }) => bitcoinTxHash.toString()),
    [mempoolTxid]
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

test("keeps mempool observations when a deposit spend raw transaction is unavailable", async () => {
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

  const transactions = await source.listMempoolTransactions()

  assert.deepEqual(
    transactions.map(({ bitcoinTxHash }) => bitcoinTxHash.toString()),
    [mempoolTxid]
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

test("keeps confirmed observations when a deposit spend raw transaction is unavailable", async () => {
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

  const transactions = await source.listConfirmedTransactions()

  assert.deepEqual(
    transactions.map(({ bitcoinTxHash }) => bitcoinTxHash.toString()),
    [confirmedTxid]
  )
  assert.equal(transactions[0].bitcoinBlockHeight, 123)
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

  const transactions = await source.listMempoolTransactions()

  assert.equal(transactions.length, 1)
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

test("isolates raw transaction failures for wallet-only candidates", async () => {
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

  const transactions = await source.listMempoolTransactions()

  assert.deepEqual(
    transactions.map(({ bitcoinTxHash }) => bitcoinTxHash.toString()),
    [mempoolTxid]
  )
  assert.deepEqual(failures, [
    {
      stage: "raw-transaction",
      spendingTxid: secondMempoolTxid,
      error: `Failed to fetch raw Bitcoin transaction ${secondMempoolTxid}: not found`,
    },
  ])
})

test("isolates a failed deposit request from another deposit spend", async () => {
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
      } as never
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

  const transactions = await source.listMempoolTransactions()

  assert.equal(transactions.length, 1)
  assert.equal(transactions[0].bitcoinTxHash.toString(), mempoolTxid)
  assert.equal(transactions[0].walletInputKeyBindings?.[0].vout, 3)
  assert.deepEqual(failures, [
    {
      stage: "deposit-request",
      fundingTxid,
      fundingOutputIndex: 2,
      error: "deposit RPC unavailable",
    },
  ])
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

test("keeps wallet transactions when reveal-history retrieval fails", async () => {
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

  const transactions = await source.listMempoolTransactions()

  assert.equal(transactions.length, 1)
  assert.deepEqual(failures, [
    { stage: "reveal-history", error: "Bridge RPC unavailable" },
  ])
})

test("wires Esplora transaction source from validated runtime config", async () => {
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
  })
  const source = createEsploraP2TRTransactionSourceFromRuntimeConfig(config, {
    taprootDepositRevealSource: emptyTaprootDepositRevealSource,
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
  const source = new EsploraP2TRSignatureFraudTransactionSource(
    "https://esplora.test",
    BitcoinNetwork.Testnet,
    [walletID],
    {
      taprootDepositRevealSource: emptyTaprootDepositRevealSource,
      onDepositScanFailure: ignoreDepositScanFailure,
      confirmedPageLimit: 2,
      fetchFn: fakeFetch({
        [addressConfirmedPath(address)]: [
          confirmedSummary(confirmedTxid, blockHash, 123),
        ],
        [`${addressConfirmedPath(address)}/${confirmedTxid}`]: [
          confirmedSummary(nextConfirmedTxid, blockHash, 124),
        ],
        [`/tx/${confirmedTxid}/hex`]: rawConfirmedTx,
        [`/tx/${nextConfirmedTxid}/hex`]: rawConfirmedTx,
      }),
    }
  )

  const transactions = await source.listConfirmedTransactions()

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

  const transactions = await source.listConfirmedTransactions()

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
          taprootDepositRevealSource: emptyTaprootDepositRevealSource,
        } as never
      ),
    /requires a deposit scan failure handler/
  )
})

function taprootDepositRevealSource(
  events: unknown[],
  extraData?: Hex
): P2TRTaprootDepositRevealSource {
  return {
    async getTaprootDepositRevealedEvents() {
      return events as never[]
    },
    async deposits() {
      return {
        depositor: { identifierHex: "23".repeat(20) },
        extraData,
      } as never
    },
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
