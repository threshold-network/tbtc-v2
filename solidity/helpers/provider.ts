interface RpcProvider {
  send(method: string, params?: unknown[]): Promise<unknown>
  request?(args: {
    method: string
    params?: readonly unknown[] | Record<string, unknown>
  }): Promise<unknown>
}

const normalizedProviders = new WeakSet<RpcProvider>()

function normalizeResult(method: string, result: unknown): unknown {
  if (
    method === "eth_getTransactionByHash" &&
    result !== null &&
    typeof result === "object" &&
    "to" in result &&
    result.to === ""
  ) {
    return { ...result, to: null }
  }
  return result
}

/**
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
