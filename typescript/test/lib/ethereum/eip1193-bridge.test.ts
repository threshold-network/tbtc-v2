import { expect } from "chai"
import { providers } from "ethers"
import { stub } from "sinon"
import { encodeAbiParameters, encodeErrorResult, parseAbi } from "viem"
import { ethersToEip1193 } from "../../../src/lib/ethereum/eip1193-bridge"
import { EvmRevertError } from "../../../src/lib/ethereum/adapter"
import { EthereumWalletRegistry } from "../../../src/lib/ethereum/wallet-registry"
import { EthereumTBTCVault } from "../../../src/lib/ethereum/tbtc-vault"
import { BitcoinTxHash } from "../../../src/lib/bitcoin"
import { Chains } from "../../../src/lib/contracts"
import { Hex } from "../../../src/lib/utils"

const contractAddress = "0x32Be343B94f860124dC4fEe278FDCBD38C102D88"
const reason = "Wallet with the given ID has not been registered"
const revertData = encodeErrorResult({
  abi: parseAbi(["error Error(string)"]),
  errorName: "Error",
  args: [reason],
})

/**
 * Exercises the real ethers v5 call/revert translation behind a
 * FallbackProvider, with every RPC request handled in memory.
 * @param call Response or rejection to serve for eth_call.
 * @returns Fallback provider and its recorded upstream requests.
 */
function fallbackProviderWithCall(call: () => Promise<string>) {
  const upstream = new providers.StaticJsonRpcProvider(undefined, 1)
  const send = stub(upstream, "send").callsFake(async (method) => {
    switch (method) {
      case "eth_chainId":
        return "0x1"
      case "eth_blockNumber":
        return "0x10"
      case "eth_call":
        return call()
      default:
        throw new Error(`Unexpected test RPC method: ${method}`)
    }
  })
  return { provider: new providers.FallbackProvider([upstream], 1), send }
}

/**
 * Uses ethers' real JSON response processing to produce a SERVER_ERROR
 * wrapper around an RPC error, without opening a network connection.
 * @param error JSON-RPC error to serve from an in-memory data URL.
 * @returns JsonRpcProvider and its recorded requests.
 */
function jsonRpcProviderWithError(error: {
  code: number
  message: string
  data?: unknown
}) {
  const response = Buffer.from(
    JSON.stringify({ jsonrpc: "2.0", id: 42, error })
  ).toString("base64")
  const provider = new providers.JsonRpcProvider(
    `data:application/json;base64,${response}`,
    1
  )
  const send = stub(provider, "send").callThrough()
  send.withArgs("eth_chainId").resolves("0x1")
  return { provider, send }
}

describe("ethers v5 JSON-RPC error compatibility", () => {
  for (const input of ["provider", "signer"]) {
    it(`should preserve the unregistered-wallet reason and skip retries through a JSON-RPC ${input}`, async () => {
      const { provider, send } = jsonRpcProviderWithError({
        code: 3,
        message: "execution reverted",
        data: revertData,
      })
      const registry = new EthereumWalletRegistry(
        {
          signerOrProvider:
            input === "provider"
              ? provider
              : provider.getSigner(contractAddress),
          address: contractAddress,
        },
        Chains.Ethereum.Mainnet
      )

      const error = await registry
        .getWalletPublicKey(Hex.from("11".repeat(32)), true)
        .catch((error: unknown) => error)

      expect(error).to.be.instanceOf(EvmRevertError)
      expect((error as EvmRevertError).reason).to.equal(reason)
      expect(send.withArgs("eth_call").callCount).to.equal(1)
    }).timeout(15000)
  }

  it("should preserve non-retryable write simulation reverts without sending a transaction", async () => {
    const reason = "The deposit is already swept"
    const { provider, send } = jsonRpcProviderWithError({
      code: 3,
      message: "execution reverted",
      data: encodeErrorResult({
        abi: parseAbi(["error Error(string)"]),
        errorName: "Error",
        args: [reason],
      }),
    })
    const vault = new EthereumTBTCVault(
      {
        signerOrProvider: provider.getSigner(contractAddress),
        address: contractAddress,
      },
      Chains.Ethereum.Mainnet
    )

    const error = await vault
      .requestOptimisticMint(BitcoinTxHash.from("11".repeat(32)), 0)
      .catch((error: unknown) => error)

    expect(error).to.be.instanceOf(EvmRevertError)
    expect((error as EvmRevertError).reason).to.equal(reason)
    expect(send.withArgs("eth_call").callCount).to.equal(1)
    expect(send.withArgs("eth_sendTransaction").callCount).to.equal(0)
  }).timeout(15000)

  it("should preserve the code, message, and data of non-revert RPC errors", async () => {
    const rpcError = {
      code: -32005,
      message: "Query limit exceeded",
      data: { limit: 1000 },
    }
    const { provider } = jsonRpcProviderWithError(rpcError)

    const error = await ethersToEip1193(provider)
      .request({ method: "eth_getLogs", params: [{}] })
      .catch((error: unknown) => error)

    expect(error).to.deep.include(rpcError)
  })

  it("should unwrap multiple ethers error layers to the original RPC error", async () => {
    const rpcError = Object.assign(new Error("execution reverted"), {
      code: 3,
      data: revertData,
    })
    const wrapper = {
      code: "SERVER_ERROR",
      error: { code: "SERVER_ERROR", error: rpcError },
    }
    const { provider, send } = jsonRpcProviderWithError(rpcError)
    send.withArgs("eth_call").rejects(wrapper)

    const error = await ethersToEip1193(provider)
      .request({ method: "eth_call", params: [] })
      .catch((error: unknown) => error)

    expect(error).to.equal(rpcError)
  })

  it("should preserve an already unwrapped RPC error", async () => {
    const rpcError = Object.assign(new Error("execution reverted"), {
      code: 3,
      data: revertData,
    })
    const { provider, send } = jsonRpcProviderWithError(rpcError)
    send.withArgs("eth_call").rejects(rpcError)

    const error = await ethersToEip1193(provider)
      .request({ method: "eth_call", params: [] })
      .catch((error: unknown) => error)

    expect(error).to.equal(rpcError)
  })

  it("should retain transport errors that contain no JSON-RPC error", async () => {
    const transportError = Object.assign(new Error("missing response"), {
      code: "SERVER_ERROR",
      error: new Error("Connection closed"),
    })
    const { provider, send } = jsonRpcProviderWithError({
      code: 3,
      message: "execution reverted",
    })
    send.withArgs("eth_call").rejects(transportError)

    const error = await ethersToEip1193(provider)
      .request({ method: "eth_call", params: [] })
      .catch((error: unknown) => error)

    expect(error).to.equal(transportError)
  })

  it("should retain errors containing a cycle", async () => {
    const cyclicError = Object.assign(new Error("missing response"), {
      code: "SERVER_ERROR",
      error: undefined as unknown,
    })
    cyclicError.error = cyclicError
    const { provider, send } = jsonRpcProviderWithError({
      code: 3,
      message: "execution reverted",
    })
    send.withArgs("eth_call").rejects(cyclicError)

    const error = await ethersToEip1193(provider)
      .request({ method: "eth_call", params: [] })
      .catch((error: unknown) => error)

    expect(error).to.equal(cyclicError)
  })
})

describe("ethers v5 call compatibility", () => {
  it("should preserve the unregistered-wallet reason and skip retries through a FallbackProvider", async () => {
    const { provider, send } = fallbackProviderWithCall(async () => {
      throw Object.assign(new Error(`execution reverted: ${reason}`), {
        code: 3,
        data: revertData,
      })
    })
    const registry = new EthereumWalletRegistry(
      { signerOrProvider: provider, address: contractAddress },
      Chains.Ethereum.Mainnet
    )

    let error: unknown
    try {
      await registry.getWalletPublicKey(Hex.from("11".repeat(32)), true)
    } catch (e) {
      error = e
    }

    expect(error).to.be.instanceOf(EvmRevertError)
    expect((error as EvmRevertError).reason).to.equal(reason)
    expect(send.withArgs("eth_call").callCount).to.equal(1)
  }).timeout(15000)

  const reverts = [
    { name: "Error(string)", data: revertData },
    {
      name: "Panic(uint256)",
      data: encodeErrorResult({
        abi: parseAbi(["error Panic(uint256)"]),
        errorName: "Panic",
        args: [0x11n],
      }),
    },
    {
      name: "custom errors",
      data: encodeErrorResult({
        abi: parseAbi(["error WalletUnavailable(bytes32)"]),
        errorName: "WalletUnavailable",
        args: [`0x${"11".repeat(32)}`],
      }),
    },
    {
      name: "custom errors without arguments",
      data: encodeErrorResult({
        abi: parseAbi(["error WalletUnavailable()"]),
        errorName: "WalletUnavailable",
      }),
    },
  ]

  for (const { name, data } of reverts) {
    it(`should translate resolved ${name} into an RPC error with the original data`, async () => {
      const { provider } = fallbackProviderWithCall(async () => data)
      const bridge = ethersToEip1193(provider)

      let error: unknown
      try {
        await bridge.request({
          method: "eth_call",
          params: [{ to: contractAddress, data: "0x12345678" }, "latest"],
        })
      } catch (e) {
        error = e
      }

      expect(error).to.be.instanceOf(Error)
      expect(error).to.include({ code: 3, data })
    })
  }

  const successes = [
    { name: "empty return data", data: "0x" },
    {
      name: "a bytes32 starting with a revert selector",
      data: `0x08c379a0${"00".repeat(28)}`,
    },
    {
      name: "bytes containing encoded error data",
      data: encodeAbiParameters([{ type: "bytes" }], [revertData]),
    },
  ]

  for (const { name, data } of successes) {
    it(`should preserve successful calls returning ${name}`, async () => {
      const { provider } = fallbackProviderWithCall(async () => data)
      const bridge = ethersToEip1193(provider)

      expect(
        await bridge.request({
          method: "eth_call",
          params: [{ to: contractAddress, data: "0x12345678" }, "latest"],
        })
      ).to.equal(data)
    })
  }
})
