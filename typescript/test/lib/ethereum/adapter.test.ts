import { expect } from "chai"
import { stub } from "sinon"
import type { Abi, Address } from "viem"
import {
  asDeployment,
  EthereumContractConfig,
  EvmContractDeployment,
  EvmContractHandle,
  EvmEvent,
  EvmRevertError,
  positionalToNamedEventArgs,
} from "../../../src/lib/ethereum/adapter"
import { GetChainEvents } from "../../../src/lib/contracts"
import { ExecutionLoggerFn, Hex } from "../../../src/lib/utils"
import { expectContractWrite, MockEvm } from "../../utils/mock-evm"
import BridgeDeployment from "../../../src/lib/ethereum/artifacts/mainnet/Bridge.json"

const testAddress: Address = "0x32Be343B94f860124dC4fEe278FDCBD38C102D88"

const testAbi = [
  {
    type: "function",
    name: "smallValue",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint32", name: "" }],
  },
  {
    type: "function",
    name: "bigValue",
    stateMutability: "view",
    inputs: [],
    outputs: [{ type: "uint256", name: "" }],
  },
  {
    type: "function",
    name: "deposits",
    stateMutability: "view",
    inputs: [{ type: "uint256", name: "depositKey" }],
    outputs: [{ type: "uint64", name: "amount" }],
  },
  {
    type: "function",
    name: "revealDeposit",
    stateMutability: "nonpayable",
    inputs: [{ type: "bytes32", name: "blindingFactor" }],
    outputs: [],
  },
] as const satisfies Abi

const testDeployment: EvmContractDeployment = {
  address: testAddress,
  abi: testAbi,
  receipt: { blockNumber: 0 },
}

/**
 * Test subclass exposing the protected adapter primitives.
 */
class TestContractHandle extends EvmContractHandle {
  read<T>(
    functionName: string,
    args?: readonly unknown[],
    opts?: { blockNumber?: number; retries?: number }
  ): Promise<T> {
    return this._read<T>(functionName, args, opts)
  }

  write(
    functionName: string,
    args: readonly unknown[],
    opts?: {
      value?: bigint
      nonRetryableErrors?: Array<string | RegExp>
      logger?: ExecutionLoggerFn
    }
  ): Promise<Hex> {
    return this._write(functionName, args, opts)
  }

  getEvents(
    eventName: string,
    options?: GetChainEvents.Options,
    ...filterArgs: Array<unknown>
  ): Promise<EvmEvent[]> {
    return this._getEvents(eventName, options, ...filterArgs)
  }
}

describe("EVM adapter", () => {
  let mock: MockEvm
  let handle: TestContractHandle

  beforeEach(() => {
    mock = new MockEvm()
    const config: EthereumContractConfig = {
      address: testAddress,
      signerOrProvider: mock.asSigner(),
      deployedAtBlockNumber: 0,
    }
    handle = new TestContractHandle(config, testDeployment)
  })

  describe("contract addresses", () => {
    it("should reject an invalid checksum in a custom address before any RPC calls", () => {
      expect(
        () =>
          new TestContractHandle(
            {
              signerOrProvider: mock.asSigner(),
              address: testAddress.replace("Be", "be"),
            },
            testDeployment
          )
      ).to.throw("Invalid Ethereum address")
      expect(mock.requests).to.be.empty
    })

    it("should validate an address from a deployment artifact", () => {
      expect(
        () =>
          new TestContractHandle(
            { signerOrProvider: mock.asSigner() },
            { ...testDeployment, address: testAddress.replace("Be", "be") }
          )
      ).to.throw("Invalid Ethereum address")
    })

    for (const address of [
      testAddress,
      testAddress.toLowerCase(),
      `0x${testAddress.slice(2).toUpperCase()}`,
    ]) {
      it(`should accept the valid contract address ${address}`, () => {
        const configuredHandle = new TestContractHandle(
          { signerOrProvider: mock.asSigner(), address },
          testDeployment
        )

        expect(configuredHandle.getAddress().identifierHex).to.equal(
          testAddress.slice(2).toLowerCase()
        )
      })
    }
  })

  describe("reads", () => {
    it("should decode a stubbed read result", async () => {
      mock.stubRead(testAddress, testAbi, "deposits", [123n], 5000n)

      const result = await handle.read<bigint>("deposits", [123n])

      expect(result).to.equal(5000n)
    })

    it("should pass the blockNumber option down to eth_call", async () => {
      mock.stubRead(testAddress, testAbi, "bigValue", [], 1n)

      await handle.read<bigint>("bigValue", [], { blockNumber: 100 })

      const calls = mock.requests.filter((r) => r.method === "eth_call")
      expect(calls).to.have.lengthOf(1)
      expect(calls[0].params[1]).to.equal("0x64")
    })

    it("should surface a stubbed revert reason as EvmRevertError.message", async () => {
      const reason = "Wallet with the given ID has not been registered"
      mock.stubRevert(testAddress, testAbi, "deposits", [123n], reason)

      let error: unknown
      try {
        await handle.read("deposits", [123n], { retries: 0 })
      } catch (e) {
        error = e
      }

      expect(error).to.be.instanceOf(EvmRevertError)
      expect((error as EvmRevertError).message).to.equal(reason)
      expect((error as EvmRevertError).reason).to.equal(reason)
    })
  })

  describe("width normalization (number|bigint)", () => {
    it("should decode small uints as number and wide uints as bigint", async () => {
      mock.stubRead(testAddress, testAbi, "smallValue", [], 7)
      mock.stubRead(testAddress, testAbi, "bigValue", [], 10n ** 18n)

      const small = await handle.read<number | bigint>("smallValue", [])
      const big = await handle.read<number | bigint>("bigValue", [])

      expect(typeof small).to.equal("number")
      expect(typeof big).to.equal("bigint")

      // The parser rule from the design: treat every numeric field as
      // number|bigint and normalize explicitly - immune to viem's
      // width-dependent decoding.
      expect(Number(small)).to.equal(7)
      expect(BigInt(small)).to.equal(7n)
      expect(BigInt(big)).to.equal(1000000000000000000n)
    })
  })

  describe("writes", () => {
    it("should simulate, send and return the transaction hash", async () => {
      const blindingFactor = `0x${"ab".repeat(32)}` as const
      mock.stubRead(
        testAddress,
        testAbi,
        "revealDeposit",
        [blindingFactor],
        undefined
      )

      const hash = await handle.write("revealDeposit", [blindingFactor])

      expect(hash.toPrefixedString()).to.match(/^0x[0-9a-f]{64}$/)
      expect(mock.sentTransactions).to.have.lengthOf(1)
      expectContractWrite(mock, testAddress, testAbi, "revealDeposit", [
        blindingFactor,
      ])
    })

    it("should throw 'Signer not provided' in read-only mode", async () => {
      mock.accounts = []
      const readOnlyHandle = new TestContractHandle(
        { signerOrProvider: mock.asSigner() },
        testDeployment
      )

      const messages: string[] = []
      let error: unknown
      try {
        await readOnlyHandle.write("revealDeposit", [`0x${"ab".repeat(32)}`], {
          logger: (message) => messages.push(message),
        })
      } catch (e) {
        error = e
      }

      expect((error as Error).message).to.equal("Signer not provided")
      expect(messages.some((message) => message.includes("retrying"))).to.be
        .false
      expect(mock.sentTransactions).to.be.empty
    })

    it("should retry connection initialization before simulating and sending a write", async () => {
      const request = stub(mock, "request").callThrough()
      const chainId = request.withArgs({ method: "eth_chainId" })
      chainId.onFirstCall().rejects(new Error("Temporary chain ID failure"))
      handle = new TestContractHandle(
        { signerOrProvider: mock.asSigner() },
        testDeployment
      )
      const blindingFactor = `0x${"ab".repeat(32)}` as const
      mock.stubRead(
        testAddress,
        testAbi,
        "revealDeposit",
        [blindingFactor],
        undefined
      )

      const hash = await handle.write("revealDeposit", [blindingFactor])

      expect(hash.toPrefixedString()).to.match(/^0x[0-9a-f]{64}$/)
      expect(chainId.callCount).to.equal(3)
      expect(request.withArgs({ method: "eth_accounts" }).callCount).to.equal(2)
      expect(
        mock.requests.filter((r) => r.method === "eth_call")
      ).to.have.lengthOf(1)
      expect(mock.sentTransactions).to.have.lengthOf(1)
    })

    it("should apply the configured retry limit to connection failures", async () => {
      const chainId = stub(mock, "request")
        .callThrough()
        .withArgs({ method: "eth_chainId" })
        .rejects(new Error("Chain ID unavailable"))
      const retryingHandle = new TestContractHandle(
        { signerOrProvider: mock.asSigner() },
        testDeployment,
        1
      )

      let error: unknown
      try {
        await retryingHandle.write("revealDeposit", [`0x${"ab".repeat(32)}`])
      } catch (e) {
        error = e
      }

      expect((error as Error).message).to.include("Chain ID unavailable")
      expect(chainId.callCount).to.equal(2)
      expect(mock.sentTransactions).to.be.empty
    })

    it("should retry a transient account probe and send with the recovered account", async () => {
      const request = stub(mock, "request").callThrough()
      const accounts = request.withArgs({ method: "eth_accounts" })
      accounts.onFirstCall().rejects(new Error("Account probe timed out"))
      handle = new TestContractHandle(
        { signerOrProvider: mock.asSigner() },
        testDeployment
      )
      const blindingFactor = `0x${"ab".repeat(32)}` as const
      mock.stubRead(testAddress, testAbi, "revealDeposit", [blindingFactor])

      const hash = await handle.write("revealDeposit", [blindingFactor])

      expect(hash.toPrefixedString()).to.match(/^0x[0-9a-f]{64}$/)
      expect(accounts.callCount).to.equal(2)
      expect(request.withArgs({ method: "eth_chainId" }).callCount).to.equal(2)
      expect(mock.sentTransactions).to.have.lengthOf(1)
    })

    it("should allow the same handle to recover after an account probe exhausts retries", async () => {
      const request = stub(mock, "request").callThrough()
      const accounts = request.withArgs({ method: "eth_accounts" })
      const failure = new Error("Account probe timed out")
      accounts.onFirstCall().rejects(failure)
      handle = new TestContractHandle(
        { signerOrProvider: mock.asSigner() },
        testDeployment,
        0
      )
      const blindingFactor = `0x${"ab".repeat(32)}` as const
      mock.stubRead(testAddress, testAbi, "revealDeposit", [blindingFactor])

      const error = await handle
        .write("revealDeposit", [blindingFactor])
        .catch((error: unknown) => error)
      expect(error).to.equal(failure)
      expect(mock.sentTransactions).to.be.empty

      const hash = await handle.write("revealDeposit", [blindingFactor])

      expect(hash.toPrefixedString()).to.match(/^0x[0-9a-f]{64}$/)
      expect(accounts.callCount).to.equal(2)
      expect(mock.sentTransactions).to.have.lengthOf(1)
    })

    it("should honor non-retryable errors during connection initialization", async () => {
      const chainId = stub(mock, "request")
        .callThrough()
        .withArgs({ method: "eth_chainId" })
        .rejects(new Error("Unsupported chain"))
      handle = new TestContractHandle(
        { signerOrProvider: mock.asSigner() },
        testDeployment
      )

      let error: unknown
      try {
        await handle.write("revealDeposit", [`0x${"ab".repeat(32)}`], {
          nonRetryableErrors: ["Unsupported chain"],
        })
      } catch (e) {
        error = e
      }

      expect((error as Error).message).to.include("Unsupported chain")
      expect(chainId.callCount).to.equal(1)
      expect(mock.sentTransactions).to.be.empty
    })

    it("should short-circuit the retry loop when the revert matches a nonRetryableErrors entry", async () => {
      const reason = "Deposit already revealed"
      mock.stubRevert(testAddress, testAbi, "revealDeposit", undefined, reason)

      let error: unknown
      try {
        await handle.write("revealDeposit", [`0x${"ab".repeat(32)}`], {
          nonRetryableErrors: ["Deposit already revealed"],
        })
      } catch (e) {
        error = e
      }

      expect(error).to.be.instanceOf(EvmRevertError)
      expect((error as EvmRevertError).message).to.equal(reason)
      // The matcher must fire on the first attempt - exactly one simulation
      // call, no retries, nothing sent.
      expect(
        mock.requests.filter((r) => r.method === "eth_call")
      ).to.have.lengthOf(1)
      expect(mock.sentTransactions).to.have.lengthOf(0)
    })

    it("should retry a revert that matches no nonRetryableErrors entry", async () => {
      const retryingHandle = new TestContractHandle(
        {
          address: testAddress,
          signerOrProvider: mock.asSigner(),
          deployedAtBlockNumber: 0,
        },
        testDeployment,
        1
      )
      mock.stubRevert(
        testAddress,
        testAbi,
        "revealDeposit",
        undefined,
        "Deposit already revealed"
      )

      let error: unknown
      try {
        await retryingHandle.write("revealDeposit", [`0x${"ab".repeat(32)}`], {
          nonRetryableErrors: ["Some other error"],
        })
      } catch (e) {
        error = e
      }

      expect(error).to.be.instanceOf(EvmRevertError)
      // One guarded attempt + one final unguarded attempt.
      expect(
        mock.requests.filter((r) => r.method === "eth_call")
      ).to.have.lengthOf(2)
    }).timeout(10000)
  })

  describe("events", () => {
    const bridgeDeployment = asDeployment(BridgeDeployment)
    const bridgeAbi = bridgeDeployment.abi
    const walletPubKeyHash1 = `0x${"11".repeat(20)}`
    const walletPubKeyHash2 = `0x${"22".repeat(20)}`
    const redeemer1 = "0x000000000000000000000000000000000000dEaD"
    const redeemer2 = "0x32Be343B94f860124dC4fEe278FDCBD38C102D88"

    let bridgeHandle: TestContractHandle

    beforeEach(() => {
      bridgeHandle = new TestContractHandle(
        {
          address: testAddress,
          signerOrProvider: mock.asSigner(),
          deployedAtBlockNumber: 0,
        },
        { ...bridgeDeployment, address: testAddress }
      )

      mock.stubLogs(testAddress, bridgeAbi, "RedemptionRequested", [
        {
          args: {
            walletPubKeyHash: walletPubKeyHash1,
            redeemerOutputScript:
              "0x17a91486884e6be1525dab5ae0b451bd2c72cee67dcf4187",
            redeemer: redeemer1,
            requestedAmount: 10000n,
            treasuryFee: 100n,
            txMaxFee: 200n,
          },
          blockNumber: 5,
        },
        {
          args: {
            walletPubKeyHash: walletPubKeyHash2,
            redeemerOutputScript:
              "0x1600147ac2d9378a1c47e589dfb8095ca95ed2140d2726",
            redeemer: redeemer2,
            requestedAmount: 20000n,
            treasuryFee: 300n,
            txMaxFee: 400n,
          },
          blockNumber: 6,
        },
      ])
    })

    it("should map positional filter args onto named indexed inputs", async () => {
      const events = await bridgeHandle.getEvents(
        "RedemptionRequested",
        { fromBlock: 0 },
        walletPubKeyHash1
      )

      expect(events).to.have.lengthOf(1)
      expect(events[0].blockNumber).to.equal(5)
      expect(events[0].args.walletPubKeyHash).to.equal(walletPubKeyHash1)
      expect((events[0].args.redeemer as string).toLowerCase()).to.equal(
        redeemer1.toLowerCase()
      )
      // uint64 decodes as bigint.
      expect(events[0].args.requestedAmount).to.equal(10000n)
      expect(events[0].args.treasuryFee).to.equal(100n)
      expect(events[0].args.txMaxFee).to.equal(200n)
    })

    it("should skip undefined positional filter args", async () => {
      const events = await bridgeHandle.getEvents(
        "RedemptionRequested",
        { fromBlock: 0 },
        undefined,
        null,
        redeemer2
      )

      expect(events).to.have.lengthOf(1)
      expect(events[0].args.walletPubKeyHash).to.equal(walletPubKeyHash2)
    })

    it("should return all events when no filter args are passed", async () => {
      const events = await bridgeHandle.getEvents("RedemptionRequested", {
        fromBlock: 0,
      })

      expect(events).to.have.lengthOf(2)
      expect(events.map((e) => e.blockNumber)).to.deep.equal([5, 6])
    })

    it("should respect the toBlock option", async () => {
      const events = await bridgeHandle.getEvents("RedemptionRequested", {
        fromBlock: 0,
        toBlock: 5,
      })

      expect(events).to.have.lengthOf(1)
      expect(events[0].blockNumber).to.equal(5)
    })
  })

  describe("positionalToNamedEventArgs", () => {
    const bridgeAbi = asDeployment(BridgeDeployment).abi

    it("should map full ABI positions onto indexed input names", () => {
      const walletPubKeyHash = `0x${"11".repeat(20)}`
      const redeemer = "0x000000000000000000000000000000000000dEaD"

      expect(
        positionalToNamedEventArgs(bridgeAbi, "RedemptionRequested", [
          walletPubKeyHash,
          null,
          redeemer,
        ])
      ).to.deep.equal({ walletPubKeyHash, redeemer })
    })

    it("should skip undefined and null entries", () => {
      const redeemer = "0x000000000000000000000000000000000000dEaD"

      expect(
        positionalToNamedEventArgs(bridgeAbi, "RedemptionRequested", [
          undefined,
          null,
          redeemer,
        ])
      ).to.deep.equal({ redeemer })

      expect(
        positionalToNamedEventArgs(bridgeAbi, "RedemptionRequested", [
          null,
          null,
        ])
      ).to.be.undefined
    })

    it("should return undefined for empty filter args", () => {
      expect(positionalToNamedEventArgs(bridgeAbi, "RedemptionRequested", []))
        .to.be.undefined
    })

    it("should throw for an unknown event", () => {
      expect(() =>
        positionalToNamedEventArgs(bridgeAbi, "NoSuchEvent", ["0x11"])
      ).to.throw("Event NoSuchEvent not found in the contract ABI")
    })

    it("should throw when more args than ABI inputs are passed", () => {
      expect(() =>
        positionalToNamedEventArgs(bridgeAbi, "RedemptionRequested", [
          null,
          null,
          null,
          null,
          null,
          null,
          null,
        ])
      ).to.throw(
        "Event RedemptionRequested has 6 inputs but 7 filter " +
          "arguments were passed"
      )
    })

    it("should reject a non-null filter for a non-indexed input", () => {
      expect(() =>
        positionalToNamedEventArgs(bridgeAbi, "RedemptionRequested", [
          null,
          "0x0014",
        ])
      ).to.throw(
        "Cannot filter non-indexed input at position 1 of event RedemptionRequested"
      )
    })

    it("should throw loudly on unnamed indexed inputs", () => {
      const abiWithUnnamedInput: Abi = [
        {
          type: "event",
          name: "Anon",
          inputs: [{ type: "address", name: "", indexed: true }],
        },
      ]

      expect(() =>
        positionalToNamedEventArgs(abiWithUnnamedInput, "Anon", ["0x11"])
      ).to.throw(
        "Indexed input at position 0 of event Anon is unnamed; cannot map " +
          "positional filter arguments"
      )
    })
  })
})
