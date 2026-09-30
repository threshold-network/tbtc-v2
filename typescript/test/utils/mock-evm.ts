import {
  encodeAbiParameters,
  encodeErrorResult,
  encodeEventTopics,
  encodeFunctionData,
  encodeFunctionResult,
  numberToHex,
  toFunctionSelector,
  type Abi,
  type AbiEvent,
  type AbiFunction,
  type Address,
} from "viem"
import type { EthereumSigner } from "../../src/lib/ethereum/evm-connection"

/**
 * A transaction recorded by the mock's `eth_sendTransaction` handler.
 */
export interface SentTx {
  to: Address
  data: `0x${string}`
  value?: `0x${string}`
}

/**
 * Raw JSON-RPC log shape served by the mock's `eth_getLogs` handler.
 */
interface RawLog {
  address: Address
  topics: `0x${string}`[]
  data: `0x${string}`
  blockNumber: `0x${string}`
  blockHash: `0x${string}`
  transactionHash: `0x${string}`
  transactionIndex: `0x${string}`
  logIndex: `0x${string}`
  removed: boolean
}

/**
 * JSON-RPC error thrown by the mock. Shaped per EIP-1474 so that viem's
 * error parsing takes the same path it takes against real nodes.
 */
class MockRpcError extends Error {
  constructor(readonly code: number, message: string, readonly data?: unknown) {
    super(message)
    this.name = "MockRpcError"
  }
}

/**
 * ABI of the standard Solidity `Error(string)` revert.
 */
const solidityErrorAbi = [
  {
    type: "error",
    name: "Error",
    inputs: [{ name: "message", type: "string" }],
  },
] as const

/**
 * An SDK-owned EIP-1193 fake with canned JSON-RPC responses. It plugs in
 * through the SDK's own EIP-1193 acceptance path, so every test also
 * exercises `connectEvm` and the viem client plumbing.
 */
export class MockEvm {
  /**
   * Chain ID served (as hex) by `eth_chainId`.
   */
  chainId = 1
  /**
   * Fixed test signer address.
   */
  account: Address = "0xf39fd6e51aad88f6f4ce6ab8827279cfffb92266"
  /**
   * Accounts served by `eth_accounts`. When undefined, defaults to
   * `[this.account]`. Set to `[]` to simulate a read-only provider.
   */
  accounts: Address[] | undefined
  /**
   * Latest block number served by `eth_blockNumber`.
   */
  blockNumber = 1_000_000
  /**
   * Transactions recorded by `eth_sendTransaction`, in order.
   */
  readonly sentTransactions: SentTx[] = []
  /**
   * Full history of JSON-RPC requests issued against the mock.
   */
  readonly requests: { method: string; params: unknown[] }[] = []

  private readonly _reads = new Map<string, `0x${string}`>()
  private readonly _reverts = new Map<
    string,
    { message: string; data: `0x${string}` }
  >()
  private readonly _logs: RawLog[] = []

  /**
   * Stubs a read: exact-match on ABI-encoded calldata to an ABI-encoded
   * return value.
   * @param address Contract address the call targets.
   * @param abi Contract ABI.
   * @param functionName Name of the stubbed function.
   * @param args Exact positional arguments the stub matches on.
   * @param result Decoded return value(s) to serve.
   * @returns Nothing; registers the stub on the mock.
   */
  stubRead(
    address: Address,
    abi: Abi,
    functionName: string,
    args: readonly unknown[],
    result?: unknown | readonly unknown[]
  ): void {
    const calldata = encodeFunctionData({ abi, functionName, args } as never)
    const fn = abi.find(
      (item): item is AbiFunction =>
        item.type === "function" && item.name === functionName
    )
    const value: `0x${string}` =
      fn && fn.outputs.length === 0
        ? "0x"
        : encodeFunctionResult({ abi, functionName, result } as never)
    this._reads.set(this._callKey(address, calldata), value)
  }

  /**
   * Stubs a revert for `eth_call`/`eth_estimateGas`: responds with the
   * EIP-1474 error shape `{ code: 3, message: "execution reverted: <reason>",
   * data: <ABI-encoded Error(string)> }` so viem parses
   * `ContractFunctionRevertedError.reason === reason`.
   * @param address Contract address the call targets.
   * @param abi Contract ABI.
   * @param functionName Name of the stubbed function.
   * @param args Exact positional arguments the stub matches on; pass
   *        `undefined` to match any call to the function (selector match).
   * @param reason The raw revert reason string.
   * @returns Nothing; registers the stub on the mock.
   */
  stubRevert(
    address: Address,
    abi: Abi,
    functionName: string,
    args: readonly unknown[] | undefined,
    reason: string
  ): void {
    const revert = {
      message: `execution reverted: ${reason}`,
      data: encodeErrorResult({
        abi: solidityErrorAbi,
        errorName: "Error",
        args: [reason],
      }),
    }
    if (args === undefined) {
      // Selector-only match: any calldata for this function reverts.
      const fn = abi.find(
        (item): item is AbiFunction =>
          item.type === "function" && item.name === functionName
      )
      if (!fn) {
        throw new Error(`Function ${functionName} not found in the ABI`)
      }
      this._reverts.set(
        this._selectorKey(address, toFunctionSelector(fn)),
        revert
      )
    } else {
      const calldata = encodeFunctionData({ abi, functionName, args } as never)
      this._reverts.set(this._callKey(address, calldata), revert)
    }
  }

  /**
   * Stubs `eth_getLogs`: builds raw logs with topics computed via
   * `encodeEventTopics` (indexed args) and data via `encodeAbiParameters`
   * over the non-indexed inputs.
   * @param address Contract address emitting the events.
   * @param abi Contract ABI.
   * @param eventName Name of the emitted event.
   * @param events Decoded events to serve; all event inputs must be present
   *        in `args`.
   * @returns Nothing; registers the logs on the mock.
   */
  stubLogs(
    address: Address,
    abi: Abi,
    eventName: string,
    events: Array<{
      args: Record<string, unknown>
      blockNumber: number
      blockHash?: `0x${string}`
      transactionHash?: `0x${string}`
    }>
  ): void {
    const event = abi.find(
      (item): item is AbiEvent =>
        item.type === "event" && item.name === eventName
    )
    if (!event) {
      throw new Error(`Event ${eventName} not found in the ABI`)
    }
    const nonIndexedInputs = event.inputs.filter((input) => !input.indexed)

    for (const [index, entry] of events.entries()) {
      const topics = encodeEventTopics({
        abi,
        eventName,
        args: entry.args,
      } as never) as (`0x${string}` | null)[]
      if (topics.some((topic) => topic === null)) {
        throw new Error(
          `stubLogs requires all indexed args of ${eventName} to be provided`
        )
      }

      const missing = nonIndexedInputs.find(
        (input) => !(input.name! in entry.args)
      )
      if (missing) {
        throw new Error(
          `stubLogs requires all non-indexed args of ${eventName} to be ` +
            `provided; missing: ${missing.name}`
        )
      }

      const data =
        nonIndexedInputs.length > 0
          ? encodeAbiParameters(
              nonIndexedInputs,
              nonIndexedInputs.map((input) => entry.args[input.name!])
            )
          : ("0x" as const)

      const logIndex = this._logs.length
      this._logs.push({
        address,
        topics: topics as `0x${string}`[],
        data,
        blockNumber: numberToHex(entry.blockNumber),
        blockHash:
          entry.blockHash ??
          numberToHex(BigInt(0xb10c000000) + BigInt(entry.blockNumber), {
            size: 32,
          }),
        transactionHash:
          entry.transactionHash ??
          numberToHex(BigInt(0x7a0000000) + BigInt(index), { size: 32 }),
        transactionIndex: "0x0",
        logIndex: numberToHex(logIndex),
        removed: false,
      })
    }
  }

  /**
   * EIP-1193 entrypoint - this is what flows into the SDK's public
   * acceptance path.
   * @param args JSON-RPC request (method and params).
   * @returns The JSON-RPC result value.
   */
  request = async ({
    method,
    params,
  }: {
    method: string
    params?: any[]
  }): Promise<unknown> => {
    const paramList: unknown[] = Array.isArray(params) ? params : []
    this.requests.push({ method, params: paramList })

    switch (method) {
      case "eth_chainId":
        return numberToHex(this.chainId)

      case "eth_accounts":
        return this.accounts ?? [this.account]

      case "eth_blockNumber":
        return numberToHex(this.blockNumber)

      case "eth_call": {
        const tx = (paramList[0] ?? {}) as { to?: string; data?: string }
        this._maybeRevert(tx)
        const value = this._reads.get(
          this._callKey(tx.to as Address, tx.data as `0x${string}`)
        )
        if (value === undefined) {
          throw new MockRpcError(
            -32603,
            `MockEvm: no stub for eth_call to [${tx.to}] ` +
              `with data [${tx.data}]`
          )
        }
        return value
      }

      case "eth_estimateGas": {
        const tx = (paramList[0] ?? {}) as { to?: string; data?: string }
        this._maybeRevert(tx)
        return numberToHex(500_000)
      }

      case "eth_getLogs": {
        const filter = (paramList[0] ?? {}) as {
          address?: string | string[]
          topics?: (string | string[] | null)[]
          fromBlock?: string
          toBlock?: string
        }
        const fromBlock = this._blockParam(filter.fromBlock, 0)
        const toBlock = this._blockParam(filter.toBlock, this.blockNumber)
        return this._logs.filter((log) => {
          const blockNumber = parseInt(log.blockNumber, 16)
          if (blockNumber < fromBlock || blockNumber > toBlock) {
            return false
          }
          if (filter.address !== undefined) {
            const addresses = (
              Array.isArray(filter.address) ? filter.address : [filter.address]
            ).map((a) => a.toLowerCase())
            if (!addresses.includes(log.address.toLowerCase())) {
              return false
            }
          }
          if (filter.topics !== undefined) {
            for (const [i, expected] of filter.topics.entries()) {
              if (expected === null || expected === undefined) {
                continue
              }
              const actual = log.topics[i]?.toLowerCase()
              const candidates = (
                Array.isArray(expected) ? expected : [expected]
              ).map((t) => t.toLowerCase())
              if (actual === undefined || !candidates.includes(actual)) {
                return false
              }
            }
          }
          return true
        })
      }

      case "eth_sendTransaction": {
        const tx = (paramList[0] ?? {}) as {
          to?: string
          data?: string
          value?: string
        }
        this.sentTransactions.push({
          to: tx.to as Address,
          data: (tx.data ?? "0x") as `0x${string}`,
          value: tx.value as `0x${string}` | undefined,
        })
        return this._txHash(this.sentTransactions.length)
      }

      case "eth_getTransactionReceipt": {
        const hash = paramList[0] as string
        const index = this._recordedHashIndex(hash)
        if (index === undefined) {
          return null
        }
        return {
          transactionHash: hash,
          transactionIndex: "0x0",
          blockNumber: numberToHex(this.blockNumber),
          blockHash: numberToHex(BigInt(0xb10c000000) + 1n, { size: 32 }),
          from: this.account,
          to: this.sentTransactions[index].to,
          cumulativeGasUsed: "0x5208",
          gasUsed: "0x5208",
          contractAddress: null,
          logs: [],
          logsBloom: `0x${"00".repeat(256)}`,
          status: "0x1",
          effectiveGasPrice: "0x1",
          type: "0x2",
        }
      }

      case "eth_getBlockByNumber": {
        const blockNumber = this._blockParam(
          paramList[0] as string | undefined,
          this.blockNumber
        )
        const zero32 = numberToHex(0n, { size: 32 })
        return {
          number: numberToHex(blockNumber),
          hash: numberToHex(BigInt(0xb10c000000) + BigInt(blockNumber), {
            size: 32,
          }),
          parentHash: zero32,
          timestamp: numberToHex(1_700_000_000),
          nonce: "0x0000000000000000",
          difficulty: "0x0",
          totalDifficulty: "0x0",
          gasLimit: "0x1c9c380",
          gasUsed: "0x0",
          miner: "0x0000000000000000000000000000000000000000",
          extraData: "0x",
          baseFeePerGas: "0x1",
          size: "0x0",
          logsBloom: `0x${"00".repeat(256)}`,
          sha3Uncles: zero32,
          stateRoot: zero32,
          receiptsRoot: zero32,
          transactionsRoot: zero32,
          mixHash: zero32,
          transactions: [],
          uncles: [],
        }
      }

      default:
        throw new MockRpcError(
          -32601,
          `MockEvm: method ${method} not implemented`
        )
    }
  }

  /**
   * @returns The mock as an `EthereumSigner` (raw EIP-1193 provider shape) -
   *          the SDK's public acceptance path.
   */
  asSigner(): EthereumSigner {
    return { request: this.request }
  }

  private _callKey(address: Address, calldata: `0x${string}`): string {
    return `${address.toLowerCase()}|${calldata}`
  }

  private _selectorKey(address: Address, selector: string): string {
    return `${address.toLowerCase()}|selector:${selector}`
  }

  private _txHash(sequence: number): `0x${string}` {
    return numberToHex(BigInt(0xdead000000) + BigInt(sequence), { size: 32 })
  }

  private _recordedHashIndex(hash: string): number | undefined {
    for (let i = 0; i < this.sentTransactions.length; i++) {
      if (this._txHash(i + 1).toLowerCase() === hash.toLowerCase()) {
        return i
      }
    }
    return undefined
  }

  private _blockParam(value: string | undefined, defaultValue: number): number {
    if (value === undefined || value === null) {
      return defaultValue
    }
    if (value === "latest" || value === "safe" || value === "finalized") {
      return this.blockNumber
    }
    if (value === "earliest") {
      return 0
    }
    if (value === "pending") {
      return this.blockNumber
    }
    return parseInt(value, 16)
  }

  private _maybeRevert(tx: { to?: string; data?: string }): void {
    if (tx.to === undefined || tx.data === undefined) {
      return
    }
    const revert =
      this._reverts.get(
        this._callKey(tx.to as Address, tx.data as `0x${string}`)
      ) ??
      this._reverts.get(
        this._selectorKey(tx.to as Address, tx.data.slice(0, 10))
      )
    if (revert) {
      throw new MockRpcError(3, revert.message, revert.data)
    }
  }
}

/**
 * Asserts that the given contract function was called with the exact given
 * arguments via `eth_sendTransaction` on the mock. Replaces waffle's
 * `assertContractCalledWith`.
 * @param mock The mock the transactions were recorded on.
 * @param address Contract address the call should target.
 * @param abi Contract ABI.
 * @param functionName Name of the expected function.
 * @param args Exact positional arguments of the expected call.
 * @returns Nothing; throws when no recorded transaction matches.
 * @throws When no recorded transaction matches.
 */
export function expectContractWrite(
  mock: MockEvm,
  address: Address,
  abi: Abi,
  functionName: string,
  args: readonly unknown[]
): void {
  const expected = encodeFunctionData({ abi, functionName, args } as never)
  const matched = mock.sentTransactions.some(
    (tx) =>
      tx.to.toLowerCase() === address.toLowerCase() && tx.data === expected
  )
  if (!matched) {
    throw new Error(
      `Expected contract function was not called: ${functionName}(${JSON.stringify(
        args,
        (_, v) => (typeof v === "bigint" ? v.toString() : v)
      )})`
    )
  }
}
