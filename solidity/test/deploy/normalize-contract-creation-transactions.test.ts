import { expect } from "chai"
import { ethers, network } from "hardhat"
import type { EthereumProvider } from "hardhat/types"
import { HardhatEthersProvider } from "@nomicfoundation/hardhat-ethers/internal/hardhat-ethers-provider"
import normalizeContractCreationTransactions from "../../helpers/provider"

describe("contract-creation RPC normalization", () => {
  it("normalizes an empty recipient without mutating the RPC result", async () => {
    const transaction = { hash: "0x1234", to: "", input: "0x6000" }
    const provider = {
      send: async (_method: string, _params: unknown[]) => transaction,
    }
    normalizeContractCreationTransactions(provider)

    expect(
      await provider.send("eth_getTransactionByHash", ["0x1234"])
    ).to.deep.equal({ ...transaction, to: null })
    expect(transaction.to).to.equal("")
  })

  it("normalizes an empty recipient in a transaction receipt", async () => {
    const receipt = { transactionHash: "0x1234", to: "", status: 1 }
    const provider = {
      send: async (_method: string, _params: unknown[]) => receipt,
    }
    normalizeContractCreationTransactions(provider)

    expect(
      await provider.send("eth_getTransactionReceipt", ["0x1234"])
    ).to.deep.equal({ ...receipt, to: null })
    expect(receipt.to).to.equal("")
  })

  it("normalizes empty recipients embedded in a full block response", async () => {
    const block = {
      hash: "0xabcd",
      transactions: [
        { hash: "0x1234", to: "", input: "0x6000" },
        { hash: "0x5678", to: "0x1234" },
        "0x9abc",
      ],
    }
    const provider = {
      send: async (_method: string, _params: unknown[]) => block,
    }
    normalizeContractCreationTransactions(provider)

    expect(
      await provider.send("eth_getBlockByHash", ["0xabcd", true])
    ).to.deep.equal({
      ...block,
      transactions: [
        { hash: "0x1234", to: null, input: "0x6000" },
        { hash: "0x5678", to: "0x1234" },
        "0x9abc",
      ],
    })
    expect(block.transactions[0]).to.deep.equal({
      hash: "0x1234",
      to: "",
      input: "0x6000",
    })
  })

  it("preserves valid transaction results and missing transactions", async () => {
    await Promise.all(
      [null, { to: null }, { to: "0x1234" }].map(async (result) => {
        const provider = {
          send: async (_method: string, _params: unknown[]) => result,
        }
        normalizeContractCreationTransactions(provider)
        expect(
          await provider.send("eth_getTransactionByHash", ["0x1234"])
        ).to.equal(result)
      })
    )
  })

  it("leaves other RPC methods unchanged and preserves the receiver", async () => {
    const result = { to: "" }
    const provider = {
      result,
      async send(method: string, params: unknown[]) {
        expect(this).to.equal(provider)
        expect(method).to.equal("eth_call")
        expect(params).to.deep.equal([{ to: "0x1234" }, "latest"])
        return this.result
      },
    }
    normalizeContractCreationTransactions(provider)
    expect(
      await provider.send("eth_call", [{ to: "0x1234" }, "latest"])
    ).to.equal(result)
  })

  it("is idempotent and propagates provider errors", async () => {
    const failure = new Error("RPC unavailable")
    const provider = {
      send: async (_method: string, _params: unknown[]) => {
        throw failure
      },
    }
    normalizeContractCreationTransactions(provider)
    const normalized = provider.send
    normalizeContractCreationTransactions(provider)
    expect(provider.send).to.equal(normalized)
    await expect(
      provider.send("eth_getTransactionByHash", ["0x1234"])
    ).to.be.rejectedWith(failure)
  })

  it("normalizes transaction reads through the ethers v6 Hardhat provider", async () => {
    const [sender, receiver] = await ethers.getSigners()
    const tx = await sender.sendTransaction({ to: receiver.address, value: 0 })
    const raw = await network.provider.send("eth_getTransactionByHash", [
      tx.hash,
    ])
    const provider = { send: async () => ({ ...raw, to: "" }) }
    normalizeContractCreationTransactions(provider)
    const reader = new HardhatEthersProvider(
      provider as unknown as EthereumProvider,
      "hardhat"
    )
    expect((await reader.getTransaction(tx.hash)).to).to.equal(null)
  })

  it("normalizes EIP-1193 requests and preserves their arguments and errors", async () => {
    const args = { method: "eth_getTransactionByHash", params: ["0x1234"] }
    const failure = new Error("RPC unavailable")
    let fail = false
    const provider = {
      send: async () => null,
      async request(requestArgs: typeof args) {
        expect(this).to.equal(provider)
        expect(requestArgs).to.equal(args)
        if (fail) throw failure
        return { to: "" }
      },
    }
    normalizeContractCreationTransactions(provider)
    const normalizedRequest = provider.request
    normalizeContractCreationTransactions(provider)
    expect(provider.request).to.equal(normalizedRequest)
    expect(await provider.request(args)).to.deep.equal({ to: null })
    fail = true
    await expect(provider.request(args)).to.be.rejectedWith(failure)
  })
})
