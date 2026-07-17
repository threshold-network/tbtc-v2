import { expect } from "chai"
import {
  createPublicClient,
  createWalletClient,
  custom,
  getAddress,
} from "viem"
import {
  chainIdFromSigner,
  connectEvm,
  ethereumAddressFromSigner,
  EthersV5ProviderLike,
  EthersV5SignerLike,
} from "../../../src/lib/ethereum/evm-connection"
import { ethersToEip1193 } from "../../../src/lib/ethereum/eip1193-bridge"
import { EthereumAddress } from "../../../src/lib/ethereum"
import { MockEvm } from "../../utils/mock-evm"

/**
 * Builds a duck-typed ethers v5 Provider fake operating in the slow path
 * (no `.send`), recording the ethers-level calls it receives.
 * @param chainId Chain ID served by `getNetwork`.
 * @returns The provider fake and its recorded calls.
 */
function ethersProviderFake(chainId = 5) {
  const calls: { method: string; args: unknown[] }[] = []
  const provider: EthersV5ProviderLike = {
    _isProvider: true,
    getNetwork: async () => {
      calls.push({ method: "getNetwork", args: [] })
      return { chainId }
    },
    call: async (tx, blockTag) => {
      calls.push({ method: "call", args: [tx, blockTag] })
      return "0xabcd"
    },
    getLogs: async (filter) => {
      calls.push({ method: "getLogs", args: [filter] })
      return [
        {
          address: "0x32Be343B94f860124dC4fEe278FDCBD38C102D88",
          topics: [`0x${"11".repeat(32)}`],
          data: "0x",
          blockNumber: 123,
          blockHash: `0x${"22".repeat(32)}`,
          transactionHash: `0x${"33".repeat(32)}`,
          transactionIndex: 1,
          logIndex: 0,
          removed: false,
        },
      ]
    },
    getBlockNumber: async () => {
      calls.push({ method: "getBlockNumber", args: [] })
      return 424242
    },
    getBlock: async (blockTag) => {
      calls.push({ method: "getBlock", args: [blockTag] })
      return { number: 424242, hash: `0x${"44".repeat(32)}`, timestamp: 1234 }
    },
    getTransactionReceipt: async (hash) => {
      calls.push({ method: "getTransactionReceipt", args: [hash] })
      return {
        transactionHash: hash,
        blockNumber: 100,
        transactionIndex: 2,
        status: 1,
        gasUsed: { toHexString: () => "0x5208" },
        logs: [],
      }
    },
  }
  return { provider, calls }
}

/**
 * Builds a duck-typed ethers v5 Signer fake, recording sent transactions.
 * @param options Optional address, chain ID and underlying provider.
 * @returns The signer fake and its recorded transactions.
 */
function ethersSignerFake(options?: {
  address?: string
  chainId?: number
  provider?: EthersV5ProviderLike
}) {
  const sentTransactions: Record<string, unknown>[] = []
  const signer: EthersV5SignerLike = {
    _isSigner: true,
    getAddress: async () =>
      options?.address ?? "0x000000000000000000000000000000000000dEaD",
    getChainId: async () => options?.chainId ?? 1,
    sendTransaction: async (tx) => {
      sentTransactions.push(tx as Record<string, unknown>)
      return { hash: `0x${"aa".repeat(32)}` }
    },
    call: async () => "0x",
    provider: options?.provider,
  }
  return { signer, sentTransactions }
}

describe("EVM connection", () => {
  describe("connectEvm detection order", () => {
    it("should recognize a viem wallet client and resolve its account via eth_accounts", async () => {
      const mock = new MockEvm()
      const walletClient = createWalletClient({ transport: custom(mock) })

      const connection = await connectEvm(walletClient)

      expect(connection.wallet).to.equal(walletClient)
      expect(connection.account).to.equal(getAddress(mock.account))
      expect(connection.chainId).to.equal("1")
      expect(
        mock.requests.filter((r) => r.method === "eth_accounts")
      ).to.have.lengthOf(1)
    })

    it("should use the viem wallet client's own account without probing eth_accounts", async () => {
      const mock = new MockEvm()
      const walletClient = createWalletClient({
        account: getAddress(mock.account),
        transport: custom(mock),
      })

      const connection = await connectEvm(walletClient)

      expect(connection.account).to.equal(getAddress(mock.account))
      expect(
        mock.requests.filter((r) => r.method === "eth_accounts")
      ).to.have.lengthOf(0)
    })

    it("should recognize a viem public client as read-only", async () => {
      const mock = new MockEvm()
      const publicClient = createPublicClient({ transport: custom(mock) })

      const connection = await connectEvm(publicClient)

      expect(connection.public).to.equal(publicClient)
      expect(connection.wallet).to.be.undefined
      expect(connection.account).to.be.undefined
      expect(connection.chainId).to.equal("1")
    })

    it("should recognize an ethers v5 signer before the raw EIP-1193 path", async () => {
      const { signer } = ethersSignerFake({ chainId: 11155111 })
      // Brand the fake with a `request` too - the `_isSigner` brand must
      // win over raw EIP-1193 detection.
      ;(signer as unknown as Record<string, unknown>).request = async () => {
        throw new Error("raw EIP-1193 path should not be used for signers")
      }

      const connection = await connectEvm(signer)

      expect(connection.wallet).to.not.be.undefined
      expect(connection.account).to.equal(
        getAddress("0x000000000000000000000000000000000000dEaD")
      )
      expect(connection.chainId).to.equal("11155111")
    })

    it("should recognize an ethers v5 provider as read-only", async () => {
      const { provider } = ethersProviderFake(5)

      const connection = await connectEvm(provider)

      expect(connection.wallet).to.be.undefined
      expect(connection.account).to.be.undefined
      expect(connection.chainId).to.equal("5")
    })

    it("should treat a raw EIP-1193 provider with accounts as a signer", async () => {
      const mock = new MockEvm()

      const connection = await connectEvm(mock.asSigner())

      expect(connection.wallet).to.not.be.undefined
      expect(connection.account).to.equal(getAddress(mock.account))
      expect(connection.chainId).to.equal("1")
    })

    it("should treat a raw EIP-1193 provider without accounts as read-only", async () => {
      const mock = new MockEvm()
      mock.accounts = []

      const connection = await connectEvm(mock.asSigner())

      expect(connection.wallet).to.be.undefined
      expect(connection.account).to.be.undefined
      expect(connection.chainId).to.equal("1")
    })

    it("should stay read-only when the eth_accounts probe is unsupported", async () => {
      const mock = new MockEvm()
      const provider = {
        request: async (args: { method: string; params?: unknown[] }) => {
          if (args.method === "eth_accounts") {
            throw new Error("the method eth_accounts does not exist")
          }
          return mock.request(args as { method: string; params?: any[] })
        },
      }

      const connection = await connectEvm(provider)

      expect(connection.wallet).to.be.undefined
      expect(connection.account).to.be.undefined
      expect(connection.chainId).to.equal("1")
    })

    it("should memoize the connection per signer instance", async () => {
      const mock = new MockEvm()
      const signer = mock.asSigner()

      const first = await connectEvm(signer)
      const requestsAfterFirst = mock.requests.length
      const second = await connectEvm(signer)

      expect(second).to.equal(first)
      expect(mock.requests.length).to.equal(requestsAfterFirst)
    })

    it("should throw for unsupported signer shapes", async () => {
      for (const value of [{}, { foo: "bar" }, null, 42, "signer"]) {
        let error: Error | undefined
        try {
          // eslint-disable-next-line no-await-in-loop
          await connectEvm(value as never)
        } catch (e) {
          error = e as Error
        }
        expect(error, `for value ${JSON.stringify(value)}`).to.not.be.undefined
        expect(error!.message).to.equal("Unsupported Ethereum signer/provider")
      }
    })
  })

  describe("ethers v5 bridge", () => {
    describe("fast path (provider with .send)", () => {
      let mock: MockEvm
      let sendCalls: Array<{ method: string; params: unknown[] }>
      let provider: EthersV5ProviderLike

      beforeEach(() => {
        mock = new MockEvm()
        sendCalls = []
        const { provider: slowProvider } = ethersProviderFake()
        provider = {
          ...slowProvider,
          send: async (method: string, params: unknown[]) => {
            sendCalls.push({ method, params })
            return mock.request({ method, params: params as any[] })
          },
        }
      })

      it("should delegate raw RPC requests to provider.send", async () => {
        const connection = await connectEvm(provider)

        const blockNumber = await connection.public.getBlockNumber()

        expect(blockNumber).to.equal(BigInt(mock.blockNumber))
        expect(
          sendCalls.filter((c) => c.method === "eth_blockNumber")
        ).to.have.lengthOf(1)
      })

      it("should answer signer-owned methods from the signer, not provider.send", async () => {
        const { signer } = ethersSignerFake({ chainId: 7, provider })

        const connection = await connectEvm(signer)

        expect(connection.chainId).to.equal("7")
        expect(
          sendCalls.filter((c) => c.method === "eth_chainId"),
          "eth_chainId must be served by signer.getChainId"
        ).to.have.lengthOf(0)
        expect(
          sendCalls.filter((c) => c.method === "eth_accounts"),
          "eth_accounts must be served by signer.getAddress"
        ).to.have.lengthOf(0)
      })

      it("should translate eth_sendTransaction to signer.sendTransaction", async () => {
        const { signer, sentTransactions } = ethersSignerFake({ provider })
        const bridge = ethersToEip1193(signer)

        const hash = await bridge.request({
          method: "eth_sendTransaction",
          params: [
            {
              from: "0x000000000000000000000000000000000000dEaD",
              to: "0x32Be343B94f860124dC4fEe278FDCBD38C102D88",
              data: "0x12345678",
              gas: "0x5208",
              value: "0x1",
              maxFeePerGas: "0xa",
              maxPriorityFeePerGas: "0x1",
            },
          ],
        })

        expect(hash).to.equal(`0x${"aa".repeat(32)}`)
        expect(sentTransactions).to.have.lengthOf(1)
        expect(sentTransactions[0]).to.deep.equal({
          to: "0x32Be343B94f860124dC4fEe278FDCBD38C102D88",
          data: "0x12345678",
          // `gas` renames to `gasLimit`; hex quantities pass through as-is;
          // `from` is dropped (implied by the signer).
          gasLimit: "0x5208",
          value: "0x1",
          maxFeePerGas: "0xa",
          maxPriorityFeePerGas: "0x1",
        })
      })
    })

    describe("slow path (provider without .send)", () => {
      it("should serve eth_chainId via getNetwork", async () => {
        const { provider, calls } = ethersProviderFake(31337)
        const bridge = ethersToEip1193(provider)

        const chainId = await bridge.request({ method: "eth_chainId" })

        expect(chainId).to.equal("0x7a69")
        expect(calls.map((c) => c.method)).to.include("getNetwork")
      })

      it("should serve eth_call via provider.call", async () => {
        const { provider, calls } = ethersProviderFake()
        const connection = await connectEvm(provider)

        const result = await connection.public.call({
          to: "0x32Be343B94f860124dC4fEe278FDCBD38C102D88",
          data: "0x70a08231",
        })

        expect(result.data).to.equal("0xabcd")
        const call = calls.find((c) => c.method === "call")
        expect(call).to.not.be.undefined
        expect(call!.args[0]).to.deep.include({ data: "0x70a08231" })
        expect(call!.args[1]).to.equal("latest")
      })

      it("should hexify block numbers", async () => {
        const { provider } = ethersProviderFake()
        const bridge = ethersToEip1193(provider)

        expect(await bridge.request({ method: "eth_blockNumber" })).to.equal(
          "0x67932"
        )
      })

      it("should translate eth_getLogs filters and hexify returned logs", async () => {
        const { provider, calls } = ethersProviderFake()
        const bridge = ethersToEip1193(provider)

        const logs = (await bridge.request({
          method: "eth_getLogs",
          params: [
            {
              address: "0x32Be343B94f860124dC4fEe278FDCBD38C102D88",
              topics: [`0x${"11".repeat(32)}`],
              fromBlock: "0xa",
              toBlock: "0x14",
            },
          ],
        })) as Record<string, unknown>[]

        const getLogs = calls.find((c) => c.method === "getLogs")
        expect(getLogs).to.not.be.undefined
        expect(getLogs!.args[0]).to.deep.equal({
          address: "0x32Be343B94f860124dC4fEe278FDCBD38C102D88",
          topics: [`0x${"11".repeat(32)}`],
          fromBlock: 10,
          toBlock: 20,
        })

        expect(logs).to.have.lengthOf(1)
        expect(logs[0].blockNumber).to.equal("0x7b")
        expect(logs[0].transactionIndex).to.equal("0x1")
        expect(logs[0].logIndex).to.equal("0x0")
        expect(logs[0].blockHash).to.equal(`0x${"22".repeat(32)}`)
      })

      it("should serve a hexified eth_getBlockByNumber subset", async () => {
        const { provider, calls } = ethersProviderFake()
        const bridge = ethersToEip1193(provider)

        const block = (await bridge.request({
          method: "eth_getBlockByNumber",
          params: ["latest", false],
        })) as Record<string, unknown>

        expect(calls.find((c) => c.method === "getBlock")!.args[0]).to.equal(
          "latest"
        )
        expect(block).to.deep.equal({
          number: "0x67932",
          hash: `0x${"44".repeat(32)}`,
          timestamp: "0x4d2",
        })
      })

      it("should hexify eth_getTransactionReceipt quantities", async () => {
        const { provider } = ethersProviderFake()
        const bridge = ethersToEip1193(provider)

        const receipt = (await bridge.request({
          method: "eth_getTransactionReceipt",
          params: [`0x${"55".repeat(32)}`],
        })) as Record<string, unknown>

        expect(receipt.transactionHash).to.equal(`0x${"55".repeat(32)}`)
        expect(receipt.blockNumber).to.equal("0x64")
        expect(receipt.transactionIndex).to.equal("0x2")
        expect(receipt.status).to.equal("0x1")
        expect(receipt.gasUsed).to.equal("0x5208")
      })

      it("should throw for methods outside the supported subset", async () => {
        const { provider } = ethersProviderFake()
        const bridge = ethersToEip1193(provider)

        let error: Error | undefined
        try {
          await bridge.request({
            method: "eth_getStorageAt",
            params: [],
          })
        } catch (e) {
          error = e as Error
        }
        expect(error).to.not.be.undefined
        expect(error!.message).to.equal(
          "Method eth_getStorageAt not supported by the ethers v5 " +
            "compatibility bridge"
        )
      })
    })
  })

  describe("chainIdFromSigner", () => {
    it("should return the decimal chain ID string", async () => {
      const mock = new MockEvm()
      mock.chainId = 11155111

      expect(await chainIdFromSigner(mock.asSigner())).to.equal("11155111")
    })
  })

  describe("ethereumAddressFromSigner", () => {
    it("should resolve the address for write-capable signers", async () => {
      const mock = new MockEvm()

      const address = await ethereumAddressFromSigner(mock.asSigner())

      expect(address).to.be.instanceOf(EthereumAddress)
      expect(address!.identifierHex).to.equal(
        mock.account.slice(2).toLowerCase()
      )
    })

    it("should return undefined for read-only signers", async () => {
      const mock = new MockEvm()
      mock.accounts = []

      expect(await ethereumAddressFromSigner(mock.asSigner())).to.be.undefined
    })
  })
})
