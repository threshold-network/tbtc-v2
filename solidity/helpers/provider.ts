interface RpcProvider {
  send(method: string, params?: unknown[]): Promise<unknown>
  request?(args: {
    method: string
    params?: readonly unknown[] | Record<string, unknown>
  }): Promise<unknown>
}

const normalizedProviders = new WeakSet<RpcProvider>()

// Single-transaction RPC methods that return a transaction object directly
// at the top level of the result.
const TRANSACTION_METHODS: Record<string, true> = {
  eth_getTransactionByHash: true,
  eth_getTransactionReceipt: true,
}

// Full-block RPC methods that, when called with the "include transactions"
// flag, embed an array of transaction objects under `result.transactions`.
const BLOCK_METHODS: Record<string, true> = {
  eth_getBlockByHash: true,
  eth_getBlockByNumber: true,
}

function normalizeContractCreationTransaction(result: unknown): unknown {
  if (
    result !== null &&
    typeof result === "object" &&
    "to" in result &&
    result.to === ""
  ) {
    return { ...result, to: null }
  }
  return result
}

function normalizeResult(method: string, result: unknown): unknown {
  if (TRANSACTION_METHODS[method]) {
    return normalizeContractCreationTransaction(result)
  }
  if (
    BLOCK_METHODS[method] &&
    result !== null &&
    typeof result === "object" &&
    "transactions" in result &&
    Array.isArray(result.transactions)
  ) {
    return {
      ...result,
      transactions: result.transactions.map(
        normalizeContractCreationTransaction
      ),
    }
  }
  return result
}

/**
 * Some RPC providers return an empty-string `to` field for contract-creation
 * transactions instead of omitting it or returning `null`. Ethers v5's
 * formatters tolerated this, but ethers v6's formatters reject an empty
 * string as an invalid address, causing `getTransaction`,
 * `getTransactionReceipt`, and full-transaction block reads to throw. This
 * normalizes an empty-string `to` field to `null` before ethers parses the
 * RPC response, covering eth_getTransactionByHash, eth_getTransactionReceipt,
 * and transactions embedded in eth_getBlockByHash/eth_getBlockByNumber
 * responses.
 *
 * Apply to hre.network.provider so both ethers v6's send calls and
 * hardhat-deploy's ethers v5 EIP-1193 requests use the same workaround.
 */
export default function normalizeContractCreationTransactions(
  provider: RpcProvider
): void {
  if (normalizedProviders.has(provider)) return
  const send = provider.send.bind(provider)
  Object.assign(provider, {
    send: async (method: string, params?: unknown[]) =>
      normalizeResult(method, await send(method, params)),
  })
  if (provider.request) {
    const request = provider.request.bind(provider)
    Object.assign(provider, {
      request: async (
        args: Parameters<NonNullable<RpcProvider["request"]>>[0]
      ) => normalizeResult(args.method, await request(args)),
    })
  }
  normalizedProviders.add(provider)
}
