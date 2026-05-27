import assert from "assert/strict"
import test from "node:test"

import { BitcoinNetwork } from "@keep-network/tbtc-v2.ts"

import {
  EsploraP2TRSignatureFraudTransactionSource,
  P2TR_SIGNATURE_FRAUD_WATCHTOWER_ENV,
  P2TREsploraFetch,
  createEsploraP2TRTransactionSourceFromRuntimeConfig,
  deriveP2TRWalletAddress,
  loadP2TRSignatureFraudWatchtowerRuntimeConfig,
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

test("derives P2TR wallet addresses from canonical x-only wallet IDs", () => {
  assert.equal(
    deriveP2TRWalletAddress(walletID, BitcoinNetwork.Testnet),
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

test("rejects confirmed Esplora transactions without block metadata", async () => {
  const address = deriveP2TRWalletAddress(walletID, BitcoinNetwork.Testnet)
  const source = new EsploraP2TRSignatureFraudTransactionSource(
    "https://esplora.test",
    BitcoinNetwork.Testnet,
    [walletID],
    {
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
        [walletID]
      ),
    /base URL is required/
  )
  assert.throws(
    () =>
      new EsploraP2TRSignatureFraudTransactionSource(
        "esplora.test",
        BitcoinNetwork.Testnet,
        [walletID]
      ),
    /base URL must be an absolute http\(s\) URL/
  )
  assert.throws(
    () =>
      new EsploraP2TRSignatureFraudTransactionSource(
        "file:///tmp/esplora",
        BitcoinNetwork.Testnet,
        [walletID]
      ),
    /base URL must be an absolute http\(s\) URL/
  )
  assert.throws(
    () =>
      new EsploraP2TRSignatureFraudTransactionSource(
        "https://esplora.test",
        BitcoinNetwork.Testnet,
        []
      ),
    /requires wallet IDs/
  )
  assert.throws(
    () =>
      new EsploraP2TRSignatureFraudTransactionSource(
        "https://esplora.test",
        BitcoinNetwork.Testnet,
        ["0x1234"]
      ),
    /wallet ID must be 32 bytes/
  )
})

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
