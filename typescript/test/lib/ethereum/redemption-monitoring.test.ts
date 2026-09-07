import { expect } from "chai"
import { toEventSelector, type Abi } from "viem"
import { EthereumBridge } from "../../../src/lib/ethereum/bridge"
import BridgeDeployment from "../../../src/lib/ethereum/artifacts/mainnet/Bridge.json"
import { Hex } from "../../../src/lib/utils"
import { MockEvm } from "../../utils/mock-evm"

const wallet = `0x${"11".repeat(20)}` as const
const otherWallet = `0x${"66".repeat(20)}` as const
const unknownWallet = `0x${"77".repeat(20)}` as const
const bridgeAddress = `0x${"88".repeat(20)}` as const
const blockHash = `0x${"22".repeat(32)}` as const
const transactionHash = `0x${"44".repeat(32)}` as const
const script = `0014${"33".repeat(20)}`
const redemptionTxHash = `0x01${"00".repeat(30)}ab` as const
const redeemer = `0x${"55".repeat(20)}` as const
const abi = BridgeDeployment.abi as Abi

const eventSignatures = {
  RedemptionsCompleted: "RedemptionsCompleted(bytes20,bytes32)",
  RedemptionTimedOut: "RedemptionTimedOut(bytes20,bytes)",
  RedemptionRequested:
    "RedemptionRequested(bytes20,bytes,address,uint64,uint64,uint64)",
} as const

type RedemptionEventName = keyof typeof eventSignatures

type LogFilter = {
  address: string
  fromBlock: string
  toBlock: string
  topics: (string | string[] | null)[]
}

function walletTopic(value: string): string {
  // Indexed bytes20 values occupy the high bytes of a 32-byte ABI word.
  return value.padEnd(66, "0")
}

function eventQuery(eventName: RedemptionEventName) {
  const provider = new MockEvm()
  const filters: LogFilter[] = []
  const request = provider.request
  provider.request = async (args) => {
    if (args.method === "eth_getLogs") {
      filters.push(args.params![0] as LogFilter)
    }
    return request(args)
  }
  provider.stubLogs(
    bridgeAddress,
    abi,
    eventName,
    [wallet, otherWallet].map((value, index) => ({
      args: {
        walletPubKeyHash: value,
        redemptionTxHash,
        redeemerOutputScript: `0x16${script}`,
        redeemer,
        requestedAmount: BigInt((index + 1) * 100000),
        treasuryFee: BigInt((index + 1) * 100),
        txMaxFee: BigInt((index + 1) * 1000),
      },
      blockNumber: 123,
      blockHash,
      transactionHash,
    }))
  )
  const instance = new EthereumBridge({
    signerOrProvider: provider,
    address: bridgeAddress,
  })
  const query =
    eventName === "RedemptionsCompleted"
      ? instance.getRedemptionsCompletedEvents.bind(instance)
      : instance.getRedemptionTimedOutEvents.bind(instance)
  return { provider, filters, instance, query }
}

function redemptionRequestedQuery() {
  const result = eventQuery("RedemptionRequested")
  return {
    ...result,
    query: result.instance.getRedemptionRequestedEvents.bind(result.instance),
  }
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
          expect(filters[0].fromBlock).to.equal("0x64")
          expect(filters[0].toBlock).to.equal("0xc8")
          expect(filters[0].topics).to.deep.equal([
            toEventSelector(eventSignatures[eventName]),
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
        const request = provider.request
        const requests: LogFilter[] = []
        provider.request = async (args) => {
          if (args.method === "eth_getLogs") {
            requests.push(args.params![0] as LogFilter)
            if (requests.length === 1) {
              throw new Error("query range too large")
            }
          }
          return request(args)
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
          requests.map(({ fromBlock, toBlock }) => [
            Number(fromBlock),
            Number(toBlock),
          ])
        ).to.deep.equal([
          [100, 200],
          [100, 140],
          [141, 181],
          [182, 200],
        ])
        for (const request of requests) {
          expect(request.topics).to.deep.equal([
            toEventSelector(eventSignatures[eventName]),
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
        const request = provider.request
        const requests: LogFilter[] = []
        provider.request = async (args) => {
          if (args.method === "eth_getLogs") {
            requests.push(args.params![0] as LogFilter)
            if (requests.length <= 2) {
              throw new Error("RPC temporarily unavailable")
            }
          }
          return request(args)
        }
        const events = await query(
          { fromBlock: 100, toBlock: 200, retries: 1 },
          wallet
        )
        expect(requests).to.have.length(3)
        for (const request of requests) {
          expect(request.fromBlock).to.equal("0x64")
          expect(request.toBlock).to.equal("0xc8")
          expect(request.topics).to.deep.equal([
            toEventSelector(eventSignatures[eventName]),
            walletTopic(wallet),
          ])
        }
        expect(events).to.have.length(1)
      })

      it("propagates provider query failures so monitoring can retry the window", async () => {
        const { provider, query } = eventQuery(eventName)
        const failure = new Error("RPC unavailable")
        const request = provider.request
        provider.request = async (args) => {
          if (args.method === "eth_getLogs") {
            throw failure
          }
          return request(args)
        }
        let caught: unknown
        try {
          await query({ fromBlock: 100, toBlock: 200, retries: 0 })
        } catch (error) {
          caught = error
        }
        expect(caught).to.be.instanceOf(Error)
        expect((caught as Error).message).to.include(failure.message)
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
        expect(filters[0].fromBlock).to.equal("0x64")
        expect(filters[0].toBlock).to.equal("0xc8")
        expect(filters[0].topics).to.deep.equal([
          toEventSelector(eventSignatures.RedemptionRequested),
          ...testCase.topics,
          // viem includes an explicit wildcard for the unfiltered redeemer.
          ...(testCase.topics.length > 0 ? [null] : []),
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
              ? [100000n, 100n, 1000n]
              : [200000n, 200n, 2000n]
          expect(event.requestedAmount).to.equal(expectedAmounts[0])
          expect(event.treasuryFee).to.equal(expectedAmounts[1])
          expect(event.txMaxFee).to.equal(expectedAmounts[2])
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
    const provider = new MockEvm()
    const instance = new EthereumBridge({
      signerOrProvider: provider,
      address: bridgeAddress,
    })
    provider.stubRead(
      bridgeAddress,
      abi,
      "redemptionParameters",
      [],
      [10000n, 100n, 1000n, 10000n, 172800, 100000n, 10]
    )
    provider.stubRead(
      bridgeAddress,
      abi,
      "pendingRedemptions",
      [
        BigInt(
          EthereumBridge.buildRedemptionKey(Hex.from(wallet), Hex.from(script))
        ),
      ],
      {
        redeemer,
        requestedAmount: 100000n,
        treasuryFee: 100n,
        txMaxFee: 1000n,
        requestedAt: 1234,
      }
    )
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
    expect(pending.requestedAmount).to.equal(100000n)
    expect(pending.treasuryFee).to.equal(100n)
    expect(pending.txMaxFee).to.equal(1000n)
    const observedBlocks = provider.requests
      .filter(({ method }) => method === "eth_call")
      .map(({ params }) => params[1])
    expect(observedBlocks).to.deep.equal([
      "0x0",
      "latest",
      "latest",
      "0x0",
      "0xc8",
    ])
  })
})
