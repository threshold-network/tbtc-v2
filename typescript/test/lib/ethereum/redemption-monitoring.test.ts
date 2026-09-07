import { expect } from "chai"
import { BigNumber, providers, utils } from "ethers"
import { EthereumBridge } from "../../../src/lib/ethereum/bridge"
import { Hex } from "../../../src/lib/utils"

const wallet = `0x${"11".repeat(20)}`
const otherWallet = `0x${"66".repeat(20)}`
const unknownWallet = `0x${"77".repeat(20)}`
const bridgeAddress = `0x${"88".repeat(20)}`
const blockHash = `0x${"22".repeat(32)}`
const transactionHash = `0x${"44".repeat(32)}`
const script = `0014${"33".repeat(20)}`
const redemptionTxHash = `0x01${"00".repeat(30)}ab`
const redeemer = `0x${"55".repeat(20)}`

const eventInterface = new utils.Interface([
  "event RedemptionsCompleted(bytes20 indexed walletPubKeyHash, bytes32 redemptionTxHash)",
  "event RedemptionTimedOut(bytes20 indexed walletPubKeyHash, bytes redeemerOutputScript)",
])

const redemptionRequestedInterface = new utils.Interface([
  "event RedemptionRequested(bytes20 indexed walletPubKeyHash, bytes redeemerOutputScript, address indexed redeemer, uint64 requestedAmount, uint64 treasuryFee, uint64 txMaxFee)",
])

type RedemptionEventName = "RedemptionsCompleted" | "RedemptionTimedOut"

function walletTopic(value: string): string {
  return utils.defaultAbiCoder.encode(["bytes20"], [value])
}

function eventLog(
  eventName: RedemptionEventName,
  walletPublicKeyHash: string,
  logIndex: number
): providers.Log {
  const encoded = eventInterface.encodeEventLog(
    eventInterface.getEvent(eventName),
    [
      walletPublicKeyHash,
      eventName === "RedemptionsCompleted" ? redemptionTxHash : `0x16${script}`,
    ]
  )
  // Event encoding follows the ABI's right padding for indexed bytes20.
  expect(encoded.topics[1]).to.equal(walletTopic(walletPublicKeyHash))
  return {
    ...encoded,
    address: bridgeAddress,
    blockNumber: 123,
    blockHash,
    transactionHash,
    transactionIndex: 0,
    logIndex,
    removed: false,
  }
}

function eventQuery(eventName: RedemptionEventName) {
  const provider = new providers.StaticJsonRpcProvider(undefined, {
    name: "mainnet",
    chainId: 1,
  })
  const filters: providers.Filter[] = []
  const logs = [wallet, otherWallet].map((value, index) =>
    eventLog(eventName, value, index)
  )
  provider.getLogs = async (requestedFilter) => {
    const filter: providers.Filter = await requestedFilter
    filters.push(filter)
    return logs.filter((log) => {
      const fromBlock =
        typeof filter.fromBlock === "number" ? filter.fromBlock : 0
      const toBlock =
        typeof filter.toBlock === "number" ? filter.toBlock : Infinity
      return (
        log.blockNumber >= fromBlock &&
        log.blockNumber <= toBlock &&
        (filter.topics ?? []).every((topic, index) => {
          if (topic === null) return true
          if (Array.isArray(topic)) {
            // Real JSON-RPC/Geth semantics: an empty topic array is
            // unconstrained and matches everything. Production code must
            // short-circuit before ever querying with an empty wallet list.
            return topic.length === 0 || topic.includes(log.topics[index])
          }
          return topic === log.topics[index]
        })
      )
    })
  }
  const instance = new EthereumBridge({
    signerOrProvider: provider,
    address: bridgeAddress,
  })
  const query =
    eventName === "RedemptionsCompleted"
      ? instance.getRedemptionsCompletedEvents.bind(instance)
      : instance.getRedemptionTimedOutEvents.bind(instance)
  return { provider, filters, query }
}

function redemptionRequestedEventLog(
  walletPublicKeyHash: string,
  redeemerAddress: string,
  requestedAmount: number,
  treasuryFee: number,
  txMaxFee: number,
  logIndex: number
): providers.Log {
  const encoded = redemptionRequestedInterface.encodeEventLog(
    redemptionRequestedInterface.getEvent("RedemptionRequested"),
    [
      walletPublicKeyHash,
      `0x16${script}`,
      redeemerAddress,
      requestedAmount,
      treasuryFee,
      txMaxFee,
    ]
  )
  // Event encoding follows the ABI's right padding for indexed bytes20.
  expect(encoded.topics[1]).to.equal(walletTopic(walletPublicKeyHash))
  return {
    ...encoded,
    address: bridgeAddress,
    blockNumber: 123,
    blockHash,
    transactionHash,
    transactionIndex: 0,
    logIndex,
    removed: false,
  }
}

function redemptionRequestedQuery() {
  const provider = new providers.StaticJsonRpcProvider(undefined, {
    name: "mainnet",
    chainId: 1,
  })
  const filters: providers.Filter[] = []
  const logs = [
    redemptionRequestedEventLog(wallet, redeemer, 100000, 100, 1000, 0),
    redemptionRequestedEventLog(otherWallet, redeemer, 200000, 200, 2000, 1),
  ]
  provider.getLogs = async (requestedFilter) => {
    const filter: providers.Filter = await requestedFilter
    filters.push(filter)
    return logs.filter((log) => {
      const fromBlock =
        typeof filter.fromBlock === "number" ? filter.fromBlock : 0
      const toBlock =
        typeof filter.toBlock === "number" ? filter.toBlock : Infinity
      return (
        log.blockNumber >= fromBlock &&
        log.blockNumber <= toBlock &&
        (filter.topics ?? []).every((topic, index) => {
          if (topic === null) return true
          if (Array.isArray(topic)) {
            return topic.length === 0 || topic.includes(log.topics[index])
          }
          return topic === log.topics[index]
        })
      )
    })
  }
  const instance = new EthereumBridge({
    signerOrProvider: provider,
    address: bridgeAddress,
  })
  return {
    provider,
    filters,
    query: instance.getRedemptionRequestedEvents.bind(instance),
  }
}

function bridge(): EthereumBridge {
  return new EthereumBridge({
    signerOrProvider: new providers.StaticJsonRpcProvider(undefined, {
      name: "mainnet",
      chainId: 1,
    }),
  })
}

describe("redemption monitoring bridge methods", () => {
  for (const eventName of [
    "RedemptionsCompleted",
    "RedemptionTimedOut",
  ] as const) {
    describe(eventName, () => {
      for (const testCase of [
        {
          name: "a single wallet",
          args: [wallet],
          topics: [walletTopic(wallet)],
          wallets: [wallet],
        },
        {
          name: "an OR list of wallets",
          args: [[wallet, otherWallet]],
          topics: [[walletTopic(wallet), walletTopic(otherWallet)]],
          wallets: [wallet, otherWallet],
        },
        {
          name: "a single Hex wallet",
          args: [Hex.from(wallet)],
          topics: [walletTopic(wallet)],
          wallets: [wallet],
        },
        {
          name: "an OR list of Hex wallets",
          args: [[Hex.from(wallet), Hex.from(otherWallet)]],
          topics: [[walletTopic(wallet), walletTopic(otherWallet)]],
          wallets: [wallet, otherWallet],
        },
        {
          name: "an omitted wallet filter",
          args: [],
          topics: [],
          wallets: [wallet, otherWallet],
        },
        {
          name: "a null wallet wildcard",
          args: [null],
          topics: [],
          wallets: [wallet, otherWallet],
        },
        {
          name: "a nonmatching wallet",
          args: [unknownWallet],
          topics: [walletTopic(unknownWallet)],
          wallets: [],
        },
      ]) {
        it(`queries canonical emitted topics for ${testCase.name}`, async () => {
          const { filters, query } = eventQuery(eventName)
          const events = await query(
            { fromBlock: 100, toBlock: 200, retries: 0 },
            ...testCase.args
          )
          expect(filters).to.have.length(1)
          expect(filters[0].address).to.equal(bridgeAddress)
          expect(filters[0].fromBlock).to.equal(100)
          expect(filters[0].toBlock).to.equal(200)
          expect(filters[0].topics).to.deep.equal([
            eventInterface.getEventTopic(eventName),
            ...testCase.topics,
          ])
          expect(
            events.map((event) => event.walletPublicKeyHash.toPrefixedString())
          ).to.deep.equal(testCase.wallets)
          for (const event of events) {
            expect(event.blockNumber).to.equal(123)
            expect(event.blockHash.toPrefixedString()).to.equal(blockHash)
            expect(event.transactionHash.toPrefixedString()).to.equal(
              transactionHash
            )
            if ("redemptionTxHash" in event) {
              expect(event.redemptionTxHash.toString()).to.equal(
                `ab${"00".repeat(30)}01`
              )
            } else {
              expect(event.redeemerOutputScript.toString()).to.equal(script)
            }
          }
        })
      }

      for (const byteLength of [19, 21]) {
        it(`rejects a ${byteLength}-byte wallet filter before querying`, async () => {
          const { filters, query } = eventQuery(eventName)
          let caught: unknown
          try {
            await query(
              { fromBlock: 100, toBlock: 200, retries: 0 },
              `0x${"11".repeat(byteLength)}`
            )
          } catch (error) {
            caught = error
          }
          expect(caught).to.be.instanceOf(Error)
          expect(filters).to.have.length(0)
        })
      }

      it("returns no events without querying the provider for an empty wallet filter", async () => {
        const { filters, query } = eventQuery(eventName)
        const events = await query(
          { fromBlock: 100, toBlock: 200, retries: 0 },
          []
        )
        expect(filters).to.have.length(0)
        expect(events).to.deep.equal([])
      })

      it("preserves wallet topics and block options in fallback batches", async () => {
        const { provider, query } = eventQuery(eventName)
        const getLogs = provider.getLogs.bind(provider)
        const requests: providers.Filter[] = []
        provider.getLogs = async (filter) => {
          requests.push(await filter)
          if (requests.length === 1) {
            throw new Error("query range too large")
          }
          return getLogs(filter)
        }
        const messages: string[] = []
        const events = await query(
          {
            fromBlock: 100,
            toBlock: 200,
            batchedQueryBlockInterval: 40,
            retries: 0,
            logger: (message) => messages.push(message),
          },
          wallet
        )
        expect(
          requests.map(({ fromBlock, toBlock }) => [fromBlock, toBlock])
        ).to.deep.equal([
          [100, 200],
          [100, 140],
          [141, 181],
          [182, 200],
        ])
        for (const request of requests) {
          expect(request.topics).to.deep.equal([
            eventInterface.getEventTopic(eventName),
            walletTopic(wallet),
          ])
        }
        expect(messages).not.to.be.empty
        expect(events).to.have.length(1)
        expect(events[0].walletPublicKeyHash.toPrefixedString()).to.equal(
          wallet
        )
      })

      it("retries failed provider queries with the same wallet topics", async () => {
        const { provider, query } = eventQuery(eventName)
        const getLogs = provider.getLogs.bind(provider)
        const requests: providers.Filter[] = []
        provider.getLogs = async (filter) => {
          requests.push(await filter)
          if (requests.length <= 2) {
            throw new Error("RPC temporarily unavailable")
          }
          return getLogs(filter)
        }
        const events = await query(
          { fromBlock: 100, toBlock: 200, retries: 1 },
          wallet
        )
        expect(requests).to.have.length(3)
        for (const request of requests) {
          expect(request.fromBlock).to.equal(100)
          expect(request.toBlock).to.equal(200)
          expect(request.topics).to.deep.equal([
            eventInterface.getEventTopic(eventName),
            walletTopic(wallet),
          ])
        }
        expect(events).to.have.length(1)
      })

      it("propagates provider query failures so monitoring can retry the window", async () => {
        const { provider, query } = eventQuery(eventName)
        const failure = new Error("RPC unavailable")
        provider.getLogs = async () => {
          throw failure
        }
        let caught: unknown
        try {
          await query({ fromBlock: 100, toBlock: 200, retries: 0 })
        } catch (error) {
          caught = error
        }
        expect(caught).to.equal(failure)
      })
    })
  }

  describe("RedemptionRequested", () => {
    for (const testCase of [
      {
        name: "a single wallet",
        args: [wallet],
        topics: [walletTopic(wallet)],
        wallets: [wallet],
      },
      {
        name: "an OR list of wallets",
        args: [[wallet, otherWallet]],
        topics: [[walletTopic(wallet), walletTopic(otherWallet)]],
        wallets: [wallet, otherWallet],
      },
      {
        name: "an omitted wallet filter",
        args: [],
        topics: [],
        wallets: [wallet, otherWallet],
      },
      {
        name: "a null wallet wildcard",
        args: [null],
        topics: [],
        wallets: [wallet, otherWallet],
      },
      {
        name: "a nonmatching wallet",
        args: [unknownWallet],
        topics: [walletTopic(unknownWallet)],
        wallets: [],
      },
      {
        name: "a single Hex wallet",
        args: [Hex.from(wallet)],
        topics: [walletTopic(wallet)],
        wallets: [wallet],
      },
      {
        name: "an OR list of Hex wallets",
        args: [[Hex.from(wallet), Hex.from(otherWallet)]],
        topics: [[walletTopic(wallet), walletTopic(otherWallet)]],
        wallets: [wallet, otherWallet],
      },
    ]) {
      it(`queries the ABI-correct right-padded wallet topic for ${testCase.name}`, async () => {
        const { filters, query } = redemptionRequestedQuery()
        const events = await query(
          { fromBlock: 100, toBlock: 200, retries: 0 },
          ...testCase.args
        )
        expect(filters).to.have.length(1)
        expect(filters[0].address).to.equal(bridgeAddress)
        expect(filters[0].fromBlock).to.equal(100)
        expect(filters[0].toBlock).to.equal(200)
        expect(filters[0].topics).to.deep.equal([
          redemptionRequestedInterface.getEventTopic("RedemptionRequested"),
          ...testCase.topics,
        ])
        expect(
          events.map((event) => event.walletPublicKeyHash.toPrefixedString())
        ).to.deep.equal(testCase.wallets)
        for (const event of events) {
          expect(event.blockNumber).to.equal(123)
          expect(event.blockHash.toPrefixedString()).to.equal(blockHash)
          expect(event.transactionHash.toPrefixedString()).to.equal(
            transactionHash
          )
          expect(event.redeemer.identifierHex).to.equal(
            redeemer.substring(2).toLowerCase()
          )
          expect(event.redeemerOutputScript.toString()).to.equal(script)
          const expectedAmounts =
            event.walletPublicKeyHash.toPrefixedString() === wallet
              ? [100000, 100, 1000]
              : [200000, 200, 2000]
          expect(event.requestedAmount.toNumber()).to.equal(expectedAmounts[0])
          expect(event.treasuryFee.toNumber()).to.equal(expectedAmounts[1])
          expect(event.txMaxFee.toNumber()).to.equal(expectedAmounts[2])
        }
      })
    }

    for (const byteLength of [19, 21]) {
      it(`rejects a ${byteLength}-byte wallet filter before querying`, async () => {
        const { filters, query } = redemptionRequestedQuery()
        let caught: unknown
        try {
          await query(
            { fromBlock: 100, toBlock: 200, retries: 0 },
            `0x${"11".repeat(byteLength)}`
          )
        } catch (error) {
          caught = error
        }
        expect(caught).to.be.instanceOf(Error)
        expect(filters).to.have.length(0)
      })
    }

    it("rejects a second positional filter argument before querying", async () => {
      const { filters, query } = redemptionRequestedQuery()
      let caught: unknown
      try {
        await query(
          { fromBlock: 100, toBlock: 200, retries: 0 },
          wallet,
          redeemer
        )
      } catch (error) {
        caught = error
      }
      expect(caught).to.be.instanceOf(Error)
      expect(filters).to.have.length(0)
    })

    it("returns no events without querying the provider for an empty wallet filter", async () => {
      const { filters, query } = redemptionRequestedQuery()
      const events = await query(
        { fromBlock: 100, toBlock: 200, retries: 0 },
        []
      )
      expect(filters).to.have.length(0)
      expect(events).to.deep.equal([])
    })
  })

  it("reads the timeout and pending request at the requested block, including zero", async () => {
    const instance = bridge()
    const observedBlocks: unknown[] = []
    Object.defineProperty(instance, "_instance", {
      value: {
        redemptionParameters: async (overrides: { blockTag: unknown }) => {
          observedBlocks.push(overrides.blockTag)
          return { redemptionTimeout: 172800 }
        },
        pendingRedemptions: async (
          key: string,
          overrides: { blockTag: unknown }
        ) => {
          expect(key).to.equal(
            EthereumBridge.buildRedemptionKey(
              Hex.from(wallet),
              Hex.from(script)
            )
          )
          observedBlocks.push(overrides.blockTag)
          return {
            redeemer: `0x${"55".repeat(20)}`,
            requestedAmount: BigNumber.from(100000),
            treasuryFee: BigNumber.from(100),
            txMaxFee: BigNumber.from(1000),
            requestedAt: 1234,
          }
        },
      },
    })
    expect(await instance.getRedemptionTimeout(0)).to.equal(172800)
    await instance.getRedemptionTimeout()
    const pendingDefaultBlock = await instance.pendingRedemptionsByWalletPKH(
      Hex.from(wallet),
      Hex.from(script)
    )
    const pendingZeroBlock = await instance.pendingRedemptionsByWalletPKH(
      Hex.from(wallet),
      Hex.from(script),
      0
    )
    const pending = await instance.pendingRedemptionsByWalletPKH(
      Hex.from(wallet),
      Hex.from(script),
      200
    )
    expect(pendingDefaultBlock.requestedAt).to.equal(1234)
    expect(pendingZeroBlock.requestedAt).to.equal(1234)
    expect(pending.requestedAt).to.equal(1234)
    expect(observedBlocks).to.deep.equal([0, "latest", "latest", 0, 200])
  })
})
