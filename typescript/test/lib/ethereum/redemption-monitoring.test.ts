import { expect } from "chai"
import { BigNumber, providers } from "ethers"
import type { Event } from "@ethersproject/contracts"
import { EthereumBridge } from "../../../src/lib/ethereum/bridge"
import { Hex } from "../../../src/lib/utils"

const wallet = `0x${"11".repeat(20)}`
const blockHash = `0x${"22".repeat(32)}`
const transactionHash = `0x${"44".repeat(32)}`
const script = `0014${"33".repeat(20)}`

function bridge(): EthereumBridge {
  return new EthereumBridge({
    signerOrProvider: new providers.StaticJsonRpcProvider(undefined, {
      name: "mainnet",
      chainId: 1,
    }),
  })
}

describe("redemption monitoring bridge methods", () => {
  it("decodes proof completion and forwards the event window and filters", async () => {
    const instance = bridge()
    const options = { fromBlock: 100, toBlock: 200 }
    instance.getEvents = async (name, requestedOptions, ...filters) => {
      expect(name).to.equal("RedemptionsCompleted")
      expect(requestedOptions).to.equal(options)
      expect(filters).to.deep.equal([wallet])
      return [
        {
          blockNumber: 123,
          blockHash,
          transactionHash,
          args: {
            walletPubKeyHash: wallet,
            redemptionTxHash: `0x01${"00".repeat(30)}ab`,
          },
        } as unknown as Event,
      ]
    }
    const [event] = await instance.getRedemptionsCompletedEvents(
      options,
      wallet
    )
    expect(event.blockNumber).to.equal(123)
    expect(event.blockHash.toPrefixedString()).to.equal(blockHash)
    expect(event.transactionHash.toPrefixedString()).to.equal(transactionHash)
    expect(event.walletPublicKeyHash.toPrefixedString()).to.equal(wallet)
    expect(event.redemptionTxHash.toString()).to.equal(`ab${"00".repeat(30)}01`)
  })

  it("removes the CompactSize prefix from a timeout event's output script", async () => {
    const instance = bridge()
    const options = { fromBlock: 10, toBlock: 20 }
    instance.getEvents = async (name, requestedOptions) => {
      expect(name).to.equal("RedemptionTimedOut")
      expect(requestedOptions).to.equal(options)
      return [
        {
          blockNumber: 15,
          blockHash,
          transactionHash,
          args: {
            walletPubKeyHash: wallet,
            redeemerOutputScript: `0x16${script}`,
          },
        } as unknown as Event,
      ]
    }
    const [event] = await instance.getRedemptionTimedOutEvents(options)
    expect(event.redeemerOutputScript.toString()).to.equal(script)
    expect(event.walletPublicKeyHash.toPrefixedString()).to.equal(wallet)
    expect(event.transactionHash.toPrefixedString()).to.equal(transactionHash)
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
    const pending = await instance.pendingRedemptionsByWalletPKH(
      Hex.from(wallet),
      Hex.from(script),
      200
    )
    expect(pending.requestedAt).to.equal(1234)
    expect(observedBlocks).to.deep.equal([0, "latest", 200])
  })

  it("propagates event query failures so monitoring can retry the window", async () => {
    const instance = bridge()
    const failure = new Error("RPC unavailable")
    instance.getEvents = async () => {
      throw failure
    }
    for (const query of [
      () => instance.getRedemptionsCompletedEvents(),
      () => instance.getRedemptionTimedOutEvents(),
    ]) {
      let caught: unknown
      try {
        await query()
      } catch (error) {
        caught = error
      }
      expect(caught).to.equal(failure)
    }
  })
})
